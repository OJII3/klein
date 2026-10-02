import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveWebUiStaticDirectory } from "./webui-config";

test("resolves bundled Web UI assets next to the server executable", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "klein-webui-config-"));

  try {
    const staticDirectory = join(rootDirectory, "dist", "web");
    await mkdir(staticDirectory, { recursive: true });

    assert.equal(
      resolveWebUiStaticDirectory(
        join(rootDirectory, "dist", "klein"),
        join(rootDirectory, "other"),
      ),
      staticDirectory,
    );
  } finally {
    await rm(rootDirectory, { force: true, recursive: true });
  }
});

test("falls back to dist/web under the working directory for source runs", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "klein-webui-config-"));

  try {
    const staticDirectory = join(rootDirectory, "dist", "web");
    await mkdir(staticDirectory, { recursive: true });

    assert.equal(
      resolveWebUiStaticDirectory(join(rootDirectory, "src", "app", "bootstrap.ts"), rootDirectory),
      staticDirectory,
    );
  } finally {
    await rm(rootDirectory, { force: true, recursive: true });
  }
});
