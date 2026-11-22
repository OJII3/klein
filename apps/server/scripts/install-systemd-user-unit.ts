import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderSystemdUserUnit } from "./systemd-user-unit";

const UNIT_NAME = "klein.service";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const username = userInfo().username;
const unitDirectory = join(
  process.env.XDG_CONFIG_HOME || join(userInfo().homedir, ".config"),
  "systemd/user",
);
const unitPath = join(unitDirectory, UNIT_NAME);

interface RunningInstance {
  readonly pid: number;
  readonly command: string;
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
}

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
}

function capture(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => resolvePromise({ code: 1, stdout: "" }));
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout }));
  });
}

async function requireSuccess(command: string, args: readonly string[]): Promise<void> {
  const code = await run(command, args);
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${[command, ...args].join(" ")}`);
  }
}

async function findExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

async function findRunningInstances(): Promise<readonly RunningInstance[]> {
  const instances: RunningInstance[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    let cmdline: string;
    try {
      cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      // The process exited while /proc was being scanned.
      continue;
    }

    const args = cmdline.split("\0").filter((arg) => arg.length > 0);
    if (!args.some((arg) => /(?:^|[/\\])dist[/\\]klein$/u.test(arg))) continue;

    let cwd: string;
    try {
      cwd = await readlink(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (cwd !== repositoryRoot) continue;

    instances.push({ pid, command: args.join(" ") });
  }
  return instances;
}

async function install(): Promise<void> {
  const systemctl = await findExecutable("systemctl");
  if (!systemctl) throw new Error("systemctl was not found on PATH");

  const active =
    (await capture(systemctl, ["--user", "is-active", "--quiet", UNIT_NAME])).code === 0;
  if (!active) {
    const running = await findRunningInstances();
    if (running.length > 0) {
      const processes = running
        .map((instance) => `  PID ${instance.pid}: ${instance.command}`)
        .join("\n");
      const pids = running.map((instance) => instance.pid).join(" ");
      throw new Error(
        `Klein is already running outside systemd:\n${processes}\n` +
          `Stop it first (kill ${pids}) and run this command again.`,
      );
    }
  }

  console.log("Building Klein...");
  await requireSuccess(process.execPath, ["run", "build"]);

  const nixBinary = await findExecutable("nix");
  const unit = renderSystemdUserUnit({
    repositoryRoot,
    bunBinary: process.execPath,
    ...(nixBinary ? { nixBinary } : {}),
  });
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(unitPath, unit, "utf8");
  console.log(`Wrote ${unitPath}`);

  await requireSuccess(systemctl, ["--user", "daemon-reload"]);
  await requireSuccess(systemctl, ["--user", "enable", UNIT_NAME]);
  await requireSuccess(systemctl, ["--user", "restart", UNIT_NAME]);

  const linger = await capture("loginctl", ["show-user", username, "--property=Linger", "--value"]);
  const lingerEnabled = linger.code === 0 && linger.stdout.trim() === "yes";

  console.log(`\nStarted ${UNIT_NAME}.`);
  console.log(`  Status: systemctl --user status ${UNIT_NAME}`);
  console.log(`  Logs:   journalctl --user -u ${UNIT_NAME} -f`);
  if (!lingerEnabled) {
    console.log(
      `\nKlein starts when ${username} logs in. To start it at boot:\n` +
        `  sudo loginctl enable-linger ${username}`,
    );
  }
}

try {
  await install();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
