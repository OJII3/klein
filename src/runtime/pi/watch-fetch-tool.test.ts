import assert from "node:assert/strict";
import test from "node:test";

import {
  createWatchFetchTool,
  createWatchFetchToolFromCore,
  type WatchFetchCore,
  type WatchFetchCoreResult,
} from "./watch-fetch-tool";

function coreReturning(
  result: WatchFetchCoreResult,
  calls: { url?: string; urls?: string[]; mode?: string }[] = [],
): WatchFetchCore {
  return {
    async fetchContent(params) {
      calls.push(params);
      return result;
    },
  };
}

const signal = new AbortController().signal;

test("maps successful fetches to the watch result shape", async () => {
  const calls: { url?: string; urls?: string[]; mode?: string }[] = [];
  const tool = createWatchFetchToolFromCore(
    coreReturning(
      {
        structuredContent: {
          urls: [
            {
              url: "https://example.com",
              title: "Example",
              content: "body",
              status: 200,
              error: null,
            },
          ],
        },
      },
      calls,
    ),
  );

  const result = await tool.execute({ url: "https://example.com" }, { signal });
  assert.deepEqual(result, {
    urls: [
      {
        url: "https://example.com",
        title: "Example",
        content: "body",
        status: 200,
        error: null,
      },
    ],
  });
  assert.deepEqual(calls, [{ url: "https://example.com", mode: "raw" }]);
});

test("keeps per-URL errors when another URL succeeds", async () => {
  const tool = createWatchFetchToolFromCore(
    coreReturning({
      structuredContent: {
        urls: [
          { url: "https://example.com/ok", title: "", content: "ok", error: null },
          {
            url: "https://example.com/fail",
            title: "",
            content: "",
            error: "HTTP 500",
          },
        ],
      },
    }),
  );

  const result = (await tool.execute(
    { urls: ["https://example.com/ok", "https://example.com/fail"] },
    { signal },
  )) as { urls: { error: string | null }[] };
  assert.equal(result.urls.length, 2);
  assert.equal(result.urls[1]?.error, "HTTP 500");
});

test("fails when every URL fails", async () => {
  const tool = createWatchFetchToolFromCore(
    coreReturning({
      structuredContent: {
        urls: [
          {
            url: "https://example.com/fail",
            title: "",
            content: "",
            error: "timed out",
          },
        ],
      },
    }),
  );

  await assert.rejects(tool.execute({ url: "https://example.com/fail" }, { signal }), /timed out/u);
});

test("rejects non-http URLs and unsupported modes", async () => {
  const tool = createWatchFetchToolFromCore(coreReturning({}));
  await assert.rejects(tool.execute({ url: "file:///etc/passwd" }, { signal }), /http/u);
  await assert.rejects(
    tool.execute({ url: "https://example.com", mode: "answer" }, { signal }),
    /mode/u,
  );
});

test("truncates fetched content by UTF-8 bytes", async () => {
  const content = "あ".repeat(40_000);
  const tool = createWatchFetchToolFromCore(
    coreReturning({
      structuredContent: {
        urls: [{ url: "https://example.com", title: "", content, error: null }],
      },
    }),
  );
  const result = (await tool.execute({ url: "https://example.com" }, { signal })) as {
    urls: { content: string }[];
  };
  const truncated = result.urls[0]?.content ?? "";
  assert.ok(Buffer.byteLength(truncated, "utf8") <= 64 * 1024);
  assert.ok(!truncated.endsWith("\uFFFD"));
});

test("retries loading the fetch core after a transient failure", async () => {
  let attempts = 0;
  const tool = createWatchFetchTool({
    agentDir: "",
    async loadCore() {
      attempts += 1;
      if (attempts === 1) throw new Error("load failed");
      return coreReturning({
        structuredContent: {
          urls: [{ url: "https://example.com", title: "", content: "ok", error: null }],
        },
      });
    },
  });

  await assert.rejects(tool.execute({ url: "https://example.com" }, { signal }), /load failed/u);
  const result = await tool.execute({ url: "https://example.com" }, { signal });
  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    urls: [{ url: "https://example.com", title: "", content: "ok", error: null }],
  });
});
