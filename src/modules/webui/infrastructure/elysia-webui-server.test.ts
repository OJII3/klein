import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import { createWebUiServerApp } from "./elysia-webui-app";
import type { WebUiDependencies } from "../ports/webui";
import { createTempDir } from "../../../testing/temp-dir";

const dependencies = {
  pinoLogs: {
    list: async () => ({ items: [], nextCursor: null }),
  },
  piSessions: {
    list: async () => ({ items: [], nextCursor: null }),
    get: async () => undefined,
  },
  toolUsage: {
    read: async () => ({
      totalCalls: 0,
      totalErrors: 0,
      sessionCount: 0,
      tools: [],
      mcpServers: [],
    }),
  },
} satisfies WebUiDependencies;

test("serves client-side routes without enumerating views on the server", async () => {
  await using temp = await createTempDir("klein-webui-server-");
  const staticDirectory = temp.path;
  await mkdir(join(staticDirectory, "assets"));
  await writeFile(join(staticDirectory, "index.html"), "<!doctype html><title>Klein</title>");
  await writeFile(join(staticDirectory, "assets", "app.js"), "console.log('app')");

  const app = await createWebUiServerApp({
    ...dependencies,
    host: "127.0.0.1",
    port: 0,
    staticDirectory,
  });

  for (const pathname of ["/", "/logs", "/sessions", "/memory", "/some/deep/path"]) {
    const response = await app.handle(new Request(`http://localhost${pathname}`));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Klein/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }

  const asset = await app.handle(new Request("http://localhost/assets/app.js"));
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "console.log('app')");
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

  const missingApi = await app.handle(new Request("http://localhost/api/nope"));
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await missingApi.json(), { error: "Not found" });

  const missingAsset = await app.handle(new Request("http://localhost/assets/nope.js"));
  assert.equal(missingAsset.status, 404);
});
