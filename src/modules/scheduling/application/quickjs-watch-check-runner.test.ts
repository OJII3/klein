import assert from "node:assert/strict";
import test from "node:test";

import { QuickJsWatchCheckRunner } from "./quickjs-watch-check-runner";
import type { WatchTool } from "./watch-tool";

const fetchTool: WatchTool = {
  name: "fetch_content",
  description: "Fetch a URL as text.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  outputSchema: {
    type: "object",
    properties: { body: { type: "string" } },
    required: ["body"],
  },
  async execute(args) {
    const { url } = args as { url: string };
    return { body: `fetched ${url}` };
  },
};

test("runs a JS watch script with args and collects text output", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [], timeoutMs: 5_000 });
  const result = await runner.run({
    script: 'text("status: " + args[0]); wake();',
    args: ["green"],
  });
  assert.equal(result.output, "status: green");
  assert.equal(result.decision, "wake");
  assert.equal(result.exitCode, 0);
});

test("reports a silent decision", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [], timeoutMs: 5_000 });
  const result = await runner.run({ script: 'text("ignored"); silent();', args: [] });
  assert.equal(result.decision, "silent");
});

test("rejects a check that does not decide", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [], timeoutMs: 5_000 });
  await assert.rejects(
    runner.run({ script: 'text("no decision");', args: [] }),
    /wake\(\).*silent\(\)/u,
  );
});

test("exposes only the catalog tools as tools.<name>", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [fetchTool], timeoutMs: 5_000 });
  const result = await runner.run({
    script:
      'const result = await tools.fetch_content({ url: "https://example.com" });\n' +
      "text(result.body);\n" +
      "await silent();",
    args: [],
  });
  assert.equal(result.output, "fetched https://example.com");
});

test("does not expose fetch as a global", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [fetchTool], timeoutMs: 5_000 });
  await assert.rejects(
    runner.run({ script: "return await fetch('https://example.com');", args: [] }),
    /fetch is not defined/u,
  );
});

test("reports script errors as check failures", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [], timeoutMs: 5_000 });
  await assert.rejects(runner.run({ script: 'throw new Error("boom")', args: [] }), /boom/u);
});

test("kills JS watches that exceed their timeout", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [], timeoutMs: 100 });
  await assert.rejects(runner.run({ script: "while (true) {}", args: [] }), /タイムアウト/u);
});

test("limits the memory a watch script may allocate", async () => {
  const runner = new QuickJsWatchCheckRunner({
    tools: [],
    timeoutMs: 5_000,
    memoryLimitBytes: 16 * 1024 * 1024,
  });
  await assert.rejects(
    runner.run({
      script: "const a = []; while (true) a.push(new Array(10000).fill(1));",
      args: [],
    }),
    /out of memory/u,
  );
});

test("keeps store values between checks", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [], timeoutMs: 5_000 });
  const script = 'store("runs", (load("runs") ?? 0) + 1); silent();';
  const first = await runner.run({ script, args: [] });
  assert.deepEqual(first.state, { runs: 1 });
  const second = await runner.run({ script, args: [], state: first.state });
  assert.deepEqual(second.state, { runs: 2 });
});

test("deletes state keys stored as undefined", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [], timeoutMs: 5_000 });
  const result = await runner.run({
    script: 'store("kept", load("kept")); store("gone", undefined); silent();',
    args: [],
    state: { kept: 1, gone: 2 },
  });
  assert.deepEqual(result.state, { kept: 1 });
});

test("rejects output over the byte limit", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [], timeoutMs: 5_000, maxOutputBytes: 10 });
  await assert.rejects(runner.run({ script: 'text("01234567890"); wake();', args: [] }), /上限/u);
});
