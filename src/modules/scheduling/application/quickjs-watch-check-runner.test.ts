import assert from "node:assert/strict";
import test from "node:test";

import { QuickJsWatchCheckRunner } from "./quickjs-watch-check-runner";

test("runs a JS watch script with args and collects text output", async () => {
  const runner = new QuickJsWatchCheckRunner({ timeoutMs: 5_000 });
  const result = await runner.run({
    script: 'text("status: " + args[0]); return { changed: true };',
    args: ["green"],
  });
  assert.equal(result.output, 'status: green\n{"changed":true}');
  assert.equal(result.exitCode, 0);
});

test("reports script errors as check failures", async () => {
  const runner = new QuickJsWatchCheckRunner({ timeoutMs: 5_000 });
  await assert.rejects(runner.run({ script: 'throw new Error("boom")', args: [] }), /boom/u);
});

test("kills JS watches that exceed their timeout", async () => {
  const runner = new QuickJsWatchCheckRunner({ timeoutMs: 100 });
  await assert.rejects(runner.run({ script: "while (true) {}", args: [] }), /タイムアウト/u);
});

test("only allows http and https in the fetch helper", async () => {
  const runner = new QuickJsWatchCheckRunner({ timeoutMs: 5_000 });
  await assert.rejects(
    runner.run({ script: 'return await fetch("file:///etc/passwd");', args: [] }),
    /http/u,
  );
});
