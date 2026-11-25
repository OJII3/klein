import assert from "node:assert/strict";
import test from "node:test";

import { createWatchGitHubApiTool } from "./watch-github-tool";

const signal = new AbortController().signal;

test("fetches GitHub REST API with owner token, query params, and metadata", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const tool = createWatchGitHubApiTool({
    async resolveToken() {
      return "gho_test_token";
    },
    async fetchImpl(url, init) {
      requests.push({ url, init });
      return new Response(JSON.stringify([{ number: 42, title: "Improve loop" }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: 'W/"abc123"',
          "x-ratelimit-remaining": "4999",
        },
      });
    },
  });

  assert.equal(tool.audience, "owner");
  const result = await tool.execute(
    {
      path: "/repos/OJII3/klein/issues",
      query: { state: "open", per_page: 10 },
    },
    { signal },
  );

  assert.deepEqual(result, {
    status: 200,
    notModified: false,
    etag: 'W/"abc123"',
    rateLimitRemaining: 4999,
    data: [{ number: 42, title: "Improve loop" }],
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "https://api.github.com/repos/OJII3/klein/issues?state=open&per_page=10",
  );
  const headers = new Headers(requests[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer gho_test_token");
  assert.equal(requests[0]?.init.method, "GET");
});

test("supports conditional ETag requests with 304 Not Modified", async () => {
  const headersSeen: Headers[] = [];
  const tool = createWatchGitHubApiTool({
    async resolveToken() {
      return undefined;
    },
    async fetchImpl(_url, init) {
      headersSeen.push(new Headers(init.headers));
      return new Response(null, {
        status: 304,
        headers: {
          etag: 'W/"same"',
          "x-ratelimit-remaining": "58",
        },
      });
    },
  });

  const result = await tool.execute(
    { path: "/repos/OJII3/klein/events", etag: 'W/"same"' },
    { signal },
  );

  assert.deepEqual(result, {
    status: 304,
    notModified: true,
    etag: 'W/"same"',
    rateLimitRemaining: 58,
    data: null,
  });
  assert.equal(headersSeen[0]?.get("if-none-match"), 'W/"same"');
  assert.equal(headersSeen[0]?.get("authorization"), null);
});

test("refreshes a cached token once on HTTP 401", async () => {
  let tokenCalls = 0;
  const tool = createWatchGitHubApiTool({
    async resolveToken() {
      tokenCalls += 1;
      return tokenCalls === 1 ? "stale-token" : "fresh-token";
    },
    async fetchImpl(_url, init) {
      const auth = new Headers(init.headers).get("authorization");
      if (auth === "Bearer stale-token") {
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  const result = await tool.execute({ path: "/repos/OJII3/klein" }, { signal });
  assert.equal(tokenCalls, 2);
  assert.deepEqual(result, {
    status: 200,
    notModified: false,
    etag: null,
    rateLimitRemaining: null,
    data: { ok: true },
  });
});

test("rejects unsafe or non-path inputs", async () => {
  const tool = createWatchGitHubApiTool({
    async resolveToken() {
      return undefined;
    },
    async fetchImpl() {
      throw new Error("should not be called");
    },
  });

  for (const path of [
    "https://evil.example/repos",
    "//evil.example/repos",
    "/repos/../user",
    "/repos/a/b?foo=bar",
    "/repos/a/b#frag",
    "repos/a/b",
  ]) {
    await assert.rejects(tool.execute({ path }, { signal }), /github_api/u);
  }
});

test("rejects responses larger than the byte limit", async () => {
  const tool = createWatchGitHubApiTool({
    maxResponseBytes: 32,
    async resolveToken() {
      return undefined;
    },
    async fetchImpl() {
      return new Response(JSON.stringify({ payload: "x".repeat(100) }), { status: 200 });
    },
  });

  await assert.rejects(
    tool.execute({ path: "/repos/OJII3/klein/events" }, { signal }),
    /exceeded 32 bytes/u,
  );
});

test("surfaces GitHub API error messages without leaking tokens", async () => {
  const tool = createWatchGitHubApiTool({
    async resolveToken() {
      return "gho_super_secret";
    },
    async fetchImpl() {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 });
    },
  });

  await assert.rejects(
    tool.execute({ path: "/repos/OJII3/klein/issues" }, { signal }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 403: API rate limit exceeded/u);
      assert.doesNotMatch(error.message, /gho_super_secret/u);
      return true;
    },
  );
});
