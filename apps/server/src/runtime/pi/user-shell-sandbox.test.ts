import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { ensureUserEnvironment, resolveUserEnvironment } from "@shared/user-environment";
import { createTempDir } from "../../testing/temp-dir";
import {
  buildBubblewrapArguments,
  buildPastaArguments,
  createBubblewrapBashOperations,
  parseDefaultIpv4Gateway,
  parseNameservers,
  resolveBubblewrapBinary,
  resolvePastaBinary,
  runSandboxedCommand,
  sandboxPathEntries,
} from "./user-shell-sandbox";

const sandboxSkip =
  resolveBubblewrapBinary() === undefined
    ? "bubblewrap is not installed"
    : resolvePastaBinary() === undefined
      ? "pasta is not installed"
      : !existsSync("/dev/net/tun")
        ? "/dev/net/tun is not available"
        : false;

test("keeps only PATH entries that are visible inside the sandbox", () => {
  const entries = sandboxPathEntries("/usr/bin:/tmp:/home/example/.local/bin");

  assert.ok(entries.includes("/usr/bin"));
  assert.ok(!entries.includes("/tmp"));
  assert.ok(!entries.includes("/home/example/.local/bin"));
});

test("builds a sandbox that mounts only the user's writable directories", async () => {
  await using temp = await createTempDir("klein-user-shell-args-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
  const resolvConf = join(environment.credentialsDirectory, "resolv.conf");
  await writeFile(resolvConf, "nameserver 192.0.2.1\n");
  const args = buildBubblewrapArguments(environment, "echo ok");

  assert.ok(args.includes("--clearenv"));
  assert.ok(!args.includes("--share-net"));
  assert.ok(!args.includes("--unshare-net"));
  assert.ok(args.includes("--unshare-user-try"));
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("--ro-bind"));
  assert.ok(args.includes(environment.workspaceDirectory));
  assert.ok(args.includes(environment.homeDirectory));
  assert.ok(args.includes(environment.temporaryDirectory));
  assert.ok(args.includes(resolvConf));

  const mountedSources = new Set(
    args.flatMap((argument, index) =>
      argument === "--bind" || argument === "--ro-bind" ? [args[index + 1]] : [],
    ),
  );
  assert.ok(!mountedSources.has(environment.rootDirectory));
  assert.ok(!mountedSources.has(environment.credentialsDirectory));

  const pathIndex = args.findIndex(
    (argument, index) => argument === "--setenv" && args[index + 1] === "PATH",
  );
  assert.ok(pathIndex >= 0);
  assert.equal(args[pathIndex + 2]?.split(":")[0], environment.binDirectory);

  assert.equal(args.at(-2), "-c");
  assert.ok(args.at(-1)?.endsWith("echo ok"));
  assert.match(args.at(-1) ?? "", /ulimit -S -v/u);
  assert.ok(["/bin/bash", "/usr/bin/bash", "/bin/sh"].includes(args.at(-3) ?? ""));
});

test("builds pasta networking without host port forwarding", () => {
  const environment = resolveUserEnvironment("/tmp/agent", "123");
  const args = buildPastaArguments("/usr/bin/bwrap", environment, "echo ok", {
    forward: "192.0.2.1",
    hosts: ["192.0.2.2"],
  });

  assert.ok(args.includes("--config-net"));
  assert.ok(args.includes("--no-map-gw"));
  assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), ["-t", "none"]);
  assert.deepEqual(args.slice(args.indexOf("-u"), args.indexOf("-u") + 2), ["-u", "none"]);
  assert.deepEqual(args.slice(args.indexOf("-T"), args.indexOf("-T") + 2), ["-T", "none"]);
  assert.deepEqual(args.slice(args.indexOf("-U"), args.indexOf("-U") + 2), ["-U", "none"]);
  assert.ok(args.includes("--dns-forward"));
  assert.ok(args.includes("192.0.2.1"));
  assert.ok(args.includes("192.0.2.2"));
  assert.ok(args.includes("/usr/bin/bwrap"));
});

test("drops loopback nameservers and reads the default gateway", () => {
  assert.deepEqual(
    parseNameservers(
      "nameserver 127.0.0.53\nnameserver 192.168.0.1\nnameserver ::ffff:127.0.2.2\nnameserver fd00::1\n",
    ),
    ["192.168.0.1", "fd00::1"],
  );
  assert.equal(
    parseDefaultIpv4Gateway(
      [
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
        "wlp1s0\t00000000\t0100A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0",
      ].join("\n"),
    ),
    "192.168.0.1",
  );
});

test("runs commands inside the user's environment", { skip: sandboxSkip }, async () => {
  await using temp = await createTempDir("klein-user-shell-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
  const otherEnvironment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "456"));
  await writeFile(join(temp.path, "host-secret.txt"), "host secret");
  await writeFile(join(environment.credentialsDirectory, "credential.txt"), "credential");
  await writeFile(join(otherEnvironment.workspaceDirectory, "other.txt"), "other user");
  await writeFile(
    join(environment.binDirectory, "klein-bin-check"),
    '#!/bin/sh\nprintf "bin-command=%s\\n" "$1"\n',
    { mode: 0o755 },
  );
  const hostServer = createServer((socket) => socket.end("host"));
  await new Promise<void>((resolve) => {
    hostServer.listen(0, "127.0.0.1", () => resolve());
  });
  const hostAddress = hostServer.address();
  if (hostAddress === null || typeof hostAddress === "string") {
    throw new Error("The test server did not bind a TCP port");
  }
  const hostPort = hostAddress.port;

  try {
    const run = createRunner(createBubblewrapBashOperations(environment));
    const result = await run(
      [
        "pwd",
        'printf "HOME=%s\\n" "$HOME"',
        'printf "TMPDIR=%s\\n" "$TMPDIR"',
        "cat ../../host-secret.txt 2>/dev/null || echo host-secret-hidden",
        "cat ../credentials/credential.txt 2>/dev/null || echo credentials-hidden",
        "cat ../users/456/workspace/other.txt 2>/dev/null || echo other-user-hidden",
        `(echo >/dev/tcp/127.0.0.1/${hostPort}) 2>/dev/null && echo host-loopback-reachable || echo host-loopback-blocked`,
        "klein-bin-check ok",
        "touch written.txt && echo wrote-in-workspace",
      ].join("\n"),
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.output, new RegExp(`^${environment.workspaceDirectory}$`, "m"));
    assert.match(result.output, new RegExp(`^HOME=${environment.homeDirectory}$`, "m"));
    assert.match(result.output, new RegExp(`^TMPDIR=${environment.temporaryDirectory}$`, "m"));
    assert.match(result.output, /host-secret-hidden/);
    assert.match(result.output, /credentials-hidden/);
    assert.match(result.output, /other-user-hidden/);
    assert.match(result.output, /host-loopback-blocked/);
    assert.match(result.output, /bin-command=ok/);
    assert.match(result.output, /wrote-in-workspace/);
    await access(join(environment.workspaceDirectory, "written.txt"));
  } finally {
    hostServer.close();
  }
});

test("mounts a secret file read-only and sources it before the command", () => {
  const environment = resolveUserEnvironment("/tmp/agent", "123");
  const args = buildBubblewrapArguments(environment, "echo ok", "/tmp/secret-file.env");

  assert.ok(args.includes("/tmp/secret-file.env"));
  assert.ok(args.includes("/run/klein/secrets.env"));
  assert.match(args.at(-1) ?? "", /\. \/run\/klein\/secrets\.env/u);
  assert.ok(!args.some((argument) => argument.includes("secret-value")));
});

test(
  "injects secret variables only into the command and removes the file",
  { skip: sandboxSkip },
  async () => {
    await using temp = await createTempDir("klein-user-shell-secret-");
    const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
    const value = "secret'value\nsecond-line";

    const result = await runSandboxedCommand(
      environment,
      'printf "%s" "$KLEIN_SECRET_EXAMPLE_TOKEN"',
      { secretEnvironment: { KLEIN_SECRET_EXAMPLE_TOKEN: value } },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, value);
    assert.deepEqual(await readdir(join(environment.credentialsDirectory, "secret-runtime")), []);
  },
);

test("stops a command when the timeout expires", { skip: sandboxSkip }, async () => {
  await using temp = await createTempDir("klein-user-shell-timeout-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
  const operations = createBubblewrapBashOperations(environment);

  await assert.rejects(
    operations.exec("sleep 10", environment.workspaceDirectory, {
      onData() {},
      timeout: 0.2,
    }),
    /timeout:0.2/,
  );
});

test("applies the default timeout", { skip: sandboxSkip }, async () => {
  await using temp = await createTempDir("klein-user-shell-default-timeout-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
  const operations = createBubblewrapBashOperations(environment, {
    defaultTimeoutSeconds: 0.2,
  });

  await assert.rejects(
    operations.exec("sleep 10", environment.workspaceDirectory, { onData() {} }),
    /timeout:0.2/,
  );
});

test("stops a command that exceeds the output limit", { skip: sandboxSkip }, async () => {
  await using temp = await createTempDir("klein-user-shell-output-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
  const operations = createBubblewrapBashOperations(environment, { maxOutputBytes: 4_096 });

  await assert.rejects(
    operations.exec("yes x", environment.workspaceDirectory, { onData() {} }),
    /output limit exceeded/,
  );
});

function createRunner(operations: BashOperations): (command: string) => Promise<{
  exitCode: number | null;
  output: string;
}> {
  return async (command) => {
    const chunks: string[] = [];
    const { exitCode } = await operations.exec(command, "", {
      onData(data) {
        chunks.push(data.toString());
      },
    });
    return { exitCode, output: chunks.join("") };
  };
}
