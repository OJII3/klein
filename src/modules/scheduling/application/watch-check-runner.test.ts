import assert from "node:assert/strict";
import test from "node:test";

import { ProcessWatchCheckRunner } from "./watch-check-runner";

test("runs a check command without a shell and returns stdout", async () => {
  const runner = new ProcessWatchCheckRunner({ timeoutMs: 5_000 });
  const result = await runner.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write('changed\\n')"],
  });
  assert.equal(result.output, "changed\n");
  assert.equal(result.exitCode, 0);
});

test("reports a non-zero exit code as a check failure", async () => {
  const runner = new ProcessWatchCheckRunner({ timeoutMs: 5_000 });
  await assert.rejects(
    runner.run({
      command: process.execPath,
      args: ["-e", "process.stderr.write('broken'); process.exit(3)"],
    }),
    /終了コード 3/u,
  );
});

test("kills checks that exceed their timeout", async () => {
  const runner = new ProcessWatchCheckRunner({ timeoutMs: 50 });
  await assert.rejects(
    runner.run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.stdout.write('late'), 1_000)"],
    }),
    /タイムアウト/u,
  );
});
