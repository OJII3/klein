import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import { resolveWebUiStaticDirectory } from "./webui-config";
import { createTempDir } from "../../../testing/temp-dir";

test("resolves bundled Web UI assets next to the server executable", async () => {
  await using temp = await createTempDir("klein-webui-config-");
  const rootDirectory = temp.path;

  const staticDirectory = join(rootDirectory, "dist", "web");
  await mkdir(staticDirectory, { recursive: true });

  assert.equal(
    resolveWebUiStaticDirectory(join(rootDirectory, "dist", "klein"), join(rootDirectory, "other")),
    staticDirectory,
  );
});

test("falls back to dist/web under the working directory for source runs", async () => {
  await using temp = await createTempDir("klein-webui-config-");
  const rootDirectory = temp.path;

  const staticDirectory = join(rootDirectory, "dist", "web");
  await mkdir(staticDirectory, { recursive: true });

  assert.equal(
    resolveWebUiStaticDirectory(join(rootDirectory, "src", "app", "bootstrap.ts"), rootDirectory),
    staticDirectory,
  );
});
