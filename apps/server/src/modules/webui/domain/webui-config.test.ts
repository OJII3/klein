import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import type { AppConfig } from "@app/config-schema";
import { resolveWebUiConfig, resolveWebUiStaticDirectory } from "./webui-config";
import { createTempDir } from "../../../testing/temp-dir";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    llm: { provider: "opencode-go", model: "main-model" },
    runtime: { agentDir: "/tmp/klein-agent" },
    discord: { access: { default: "deny", directMessages: "deny" } },
    features: { sharedMemory: { enabled: false }, minecraft: { enabled: false } },
    ...overrides,
  };
}

test("starts cloudflared only when the Web UI configuration enables it", () => {
  assert.equal(resolveWebUiConfig(createConfig()).cloudflaredEnabled, false);
  assert.equal(
    resolveWebUiConfig(
      createConfig({
        features: {
          sharedMemory: { enabled: false },
          minecraft: { enabled: false },
          webui: { enabled: true, cloudflared: { enabled: true } },
        },
      }),
    ).cloudflaredEnabled,
    true,
  );
});

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
