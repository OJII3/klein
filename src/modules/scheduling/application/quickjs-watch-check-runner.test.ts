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
    script: 'text("status: " + args[0]); return { changed: true };',
    args: ["green"],
  });
  assert.equal(result.output, 'status: green\n{"changed":true}');
  assert.equal(result.exitCode, 0);
});

test("exposes only the catalog tools as tools.<name>", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [fetchTool], timeoutMs: 5_000 });
  const result = await runner.run({
    script:
      'const result = await tools.fetch_content({ url: "https://example.com" });\n' +
      "text(result.body);\n" +
      "return result;",
    args: [],
  });
  assert.equal(
    result.output,
    'fetched https://example.com\n{"body":"fetched https://example.com"}',
  );
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

test("rejects store and load instead of silently losing state", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [], timeoutMs: 5_000 });
  await assert.rejects(runner.run({ script: 'store("x", 1);', args: [] }), /store/u);
  await assert.rejects(runner.run({ script: 'return load("x");', args: [] }), /load/u);
});

test("rejects output over the byte limit", async () => {
  const runner = new QuickJsWatchCheckRunner({ tools: [], timeoutMs: 5_000, maxOutputBytes: 10 });
  await assert.rejects(runner.run({ script: 'text("01234567890");', args: [] }), /上限/u);
});
