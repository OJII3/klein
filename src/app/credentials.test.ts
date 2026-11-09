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
      USAGE_ENDPOINT: "https://usage.local/ingest",
      USAGE_TOKEN: "usage-token",
    },
  });

  assert.equal(credentials.discordBotToken, BOT_TOKEN);
  assert.equal(credentials.tunnelToken, "tunnel-token");
  assert.equal(credentials.openCodeGoApiKey, undefined);
  assert.deepEqual(credentials.usage, {
    endpoint: "https://usage.local/ingest",
    token: "usage-token",
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
      USAGE_ENDPOINT: "https://usage.local/ingest",
      USAGE_TOKEN: "",
    },
  });

  assert.equal(credentials.usage, undefined);
});
