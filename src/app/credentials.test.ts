import assert from "node:assert/strict";
import test from "node:test";

import { resolveCredentials } from "./credentials";

const BOT_TOKEN = "discord-bot-token";

test("reads the Discord bot token and the optional credentials", () => {
  const credentials = resolveCredentials({
    modelsInUse: [{ provider: "google", model: "main-model" }],
    environment: {
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      TUNNEL_TOKEN: "tunnel-token",
      LANGFUSE_PUBLIC_KEY: "langfuse-public-key",
      LANGFUSE_SECRET_KEY: "langfuse-secret-key",
      LANGFUSE_BASE_URL: "https://langfuse.local",
    },
  });

  assert.equal(credentials.discordBotToken, BOT_TOKEN);
  assert.equal(credentials.tunnelToken, "tunnel-token");
  assert.equal(credentials.openCodeGoApiKey, undefined);
  assert.deepEqual(credentials.langfuse, {
    publicKey: "langfuse-public-key",
    secretKey: "langfuse-secret-key",
    baseUrl: "https://langfuse.local",
  });
});

test("requires the Discord bot token", () => {
  assert.throws(
    () => resolveCredentials({ modelsInUse: [], environment: {} }),
    /DISCORD_BOT_TOKEN is required/,
  );
});

test("requires the OpenCode API key only when an OpenCode model is in use", () => {
  assert.doesNotThrow(() =>
    resolveCredentials({
      modelsInUse: [{ provider: "google", model: "main-model" }],
      environment: { DISCORD_BOT_TOKEN: BOT_TOKEN },
    }),
  );

  assert.throws(
    () =>
      resolveCredentials({
        modelsInUse: [{ provider: "opencode-go", model: "main-model" }],
        environment: { DISCORD_BOT_TOKEN: BOT_TOKEN },
      }),
    /OPENCODE_API_KEY is required/,
  );
});

test("treats empty values as missing", () => {
  assert.throws(
    () => resolveCredentials({ modelsInUse: [], environment: { DISCORD_BOT_TOKEN: "" } }),
    /DISCORD_BOT_TOKEN is required/,
  );

  const credentials = resolveCredentials({
    modelsInUse: [],
    environment: {
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      LANGFUSE_PUBLIC_KEY: "langfuse-public-key",
      LANGFUSE_SECRET_KEY: "",
    },
  });

  assert.equal(credentials.langfuse, undefined);
});
