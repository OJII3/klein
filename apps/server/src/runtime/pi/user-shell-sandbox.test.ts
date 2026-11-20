import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { ensureUserEnvironment, resolveUserEnvironment } from "@shared/user-environment";
import { createTempDir } from "../../testing/temp-dir";
import {
  buildBubblewrapArguments,
  createBubblewrapBashOperations,
  enablesUserShell,
  resolveBubblewrapBinary,
  sandboxPathEntries,
} from "./user-shell-sandbox";

const bubblewrapSkip =
  resolveBubblewrapBinary() === undefined ? "bubblewrap is not installed" : false;

test("limits the shell to linked-user workers", () => {
  const environment = ensureUserEnvironment(resolveUserEnvironment("/tmp/agent", "123"));

  assert.equal(enablesUserShell({ kind: "worker", workerId: "worker-1" }, environment), true);
  assert.equal(enablesUserShell({ kind: "conversation" }, environment), false);
  assert.equal(enablesUserShell({ kind: "standalone" }, environment), false);
  assert.equal(enablesUserShell({ kind: "worker", workerId: "worker-1" }, undefined), false);
});

test("keeps only PATH entries that are visible inside the sandbox", () => {
  const entries = sandboxPathEntries("/usr/bin:/tmp:/home/example/.local/bin");

  assert.ok(entries.includes("/usr/bin"));
  assert.ok(!entries.includes("/tmp"));
  assert.ok(!entries.includes("/home/example/.local/bin"));
});

test("builds a sandbox that mounts only the user's writable directories", () => {
  const environment = resolveUserEnvironment("/tmp/agent", "123");
  const args = buildBubblewrapArguments(environment, "echo ok");

  assert.ok(args.includes("--clearenv"));
  assert.ok(args.includes("--share-net"));
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("--ro-bind"));
  assert.ok(args.includes(environment.workspaceDirectory));
  assert.ok(args.includes(environment.homeDirectory));
  assert.ok(args.includes(environment.temporaryDirectory));
  assert.ok(!args.includes(environment.credentialsDirectory));
  assert.equal(args.at(-2), "-c");
  assert.equal(args.at(-1), "echo ok");
  assert.ok(["/bin/bash", "/usr/bin/bash", "/bin/sh"].includes(args.at(-3) ?? ""));
});

test("runs commands inside the user's environment", { skip: bubblewrapSkip }, async () => {
  await using temp = await createTempDir("klein-user-shell-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
  const otherEnvironment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "456"));
  await writeFile(join(temp.path, "host-secret.txt"), "host secret");
  await writeFile(join(environment.credentialsDirectory, "credential.txt"), "credential");
  await writeFile(join(otherEnvironment.workspaceDirectory, "other.txt"), "other user");
  const run = createRunner(createBubblewrapBashOperations(environment));

  const result = await run(
    [
      "pwd",
      'printf "HOME=%s\\n" "$HOME"',
      'printf "TMPDIR=%s\\n" "$TMPDIR"',
      "cat ../../host-secret.txt 2>/dev/null || echo host-secret-hidden",
      "cat ../credentials/credential.txt 2>/dev/null || echo credentials-hidden",
      "cat ../users/456/workspace/other.txt 2>/dev/null || echo other-user-hidden",
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
  assert.match(result.output, /wrote-in-workspace/);
  await access(join(environment.workspaceDirectory, "written.txt"));
});

test("stops a command when the timeout expires", { skip: bubblewrapSkip }, async () => {
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
