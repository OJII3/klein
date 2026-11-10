import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import { FileDiscordAccessRuleStore } from "./file-discord-access-rule-store";

test("loads guild, channel, and thread access rules", async () => {
  await using temp = await createTempDir("klein-discord-access-");
  const filePath = join(temp.path, "discord-access.json");
  await writeFile(
    filePath,
    JSON.stringify({
      guilds: {
        "100": {
          access: "deny",
          channels: {
            "200": {
              access: "allow",
              threads: {
                "300": { access: "owner" },
              },
            },
          },
        },
      },
    }),
  );

  const store = new FileDiscordAccessRuleStore(filePath);
  await store.load();

  assert.deepEqual(store.getGuildRule("100"), {
    access: "deny",
    channels: {
      "200": {
        access: "allow",
        threads: {
          "300": { access: "owner" },
        },
      },
    },
  });
  assert.equal(store.getGuildRule("other"), undefined);
});

test("treats a missing file as no guild rules", async () => {
  await using temp = await createTempDir("klein-discord-access-");
  const store = new FileDiscordAccessRuleStore(join(temp.path, "discord-access.json"));

  await store.load();

  assert.equal(store.getGuildRule("100"), undefined);
});

test("rejects invalid access rule files", async () => {
  await using temp = await createTempDir("klein-discord-access-");
  const filePath = join(temp.path, "discord-access.json");
  const store = new FileDiscordAccessRuleStore(filePath);

  await writeFile(filePath, "{");
  await assert.rejects(store.load(), /not valid JSON/u);

  await writeFile(filePath, JSON.stringify({ guilds: { "100": { access: "maybe" } } }));
  await assert.rejects(store.load(), /invalid/u);

  await writeFile(filePath, JSON.stringify({ guilds: { guild: { access: "allow" } } }));
  await assert.rejects(store.load(), /invalid/u);

  await writeFile(filePath, JSON.stringify({ guilds: { "100": { channels: { "200": {} } } } }));
  await store.load();
  assert.deepEqual(store.getGuildRule("100"), { channels: { "200": {} } });
});

test("writes channel and thread access without dropping other rules", async () => {
  await using temp = await createTempDir("klein-discord-access-");
  const filePath = join(temp.path, "discord-access.json");
  await writeFile(
    filePath,
    JSON.stringify({
      guilds: {
        "100": {
          access: "deny",
          channels: {
            "200": { access: "owner", threads: { "300": { access: "deny" } } },
          },
        },
      },
    }),
  );

  const store = new FileDiscordAccessRuleStore(filePath);
  await store.load();
  await store.setAccess({ guildId: "100", channelId: "200" }, "allow");
  await store.setAccess({ guildId: "100", channelId: "200", threadId: "300" }, "allow");
  await store.setAccess({ guildId: "100", channelId: "201", threadId: "301" }, "allow");

  assert.deepEqual(store.getGuildRule("100"), {
    access: "deny",
    channels: {
      "200": { access: "allow", threads: { "300": { access: "allow" } } },
      "201": { threads: { "301": { access: "allow" } } },
    },
  });

  const reloaded = new FileDiscordAccessRuleStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.getGuildRule("100"), store.getGuildRule("100"));
});
