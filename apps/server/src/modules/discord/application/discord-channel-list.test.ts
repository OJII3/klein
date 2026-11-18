import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiscordAccessPolicy,
  type DiscordGuildAccessRule,
} from "../domain/discord-access-policy";
import {
  buildAllowedDiscordChannelLines,
  type DiscordAllowedChannelListDependencies,
} from "./discord-channel-list";

const rules: DiscordGuildAccessRule = {
  access: "allow",
  channels: {
    "channel-1": {
      threads: {
        "thread-1": { access: "owner" },
        "thread-2": { access: "deny" },
      },
    },
    "channel-2": {
      access: "deny",
      threads: {
        "thread-3": { access: "allow" },
      },
    },
  },
};
const names: Readonly<Record<string, string>> = {
  "channel-1": "general",
  "channel-2": "private",
  "thread-1": "owners",
  "thread-2": "hidden",
  "thread-3": "visible",
};

function createDependencies(
  guildRule: DiscordGuildAccessRule | undefined,
): DiscordAllowedChannelListDependencies {
  const accessPolicy = createDiscordAccessPolicy(
    { default: "deny", directMessages: "deny" },
    "owner-123",
    { getGuildRule: (guildId) => (guildId === "guild-123" ? guildRule : undefined) },
  );

  return {
    getGuildRule: (guildId: string) => (guildId === "guild-123" ? guildRule : undefined),
    resolveAccess: (target) => accessPolicy.resolveAccess(target),
    resolveChannelName: async (channelId: string) => names[channelId],
  };
}

test("lists channels and threads with their resolved access", async () => {
  const lines = await buildAllowedDiscordChannelLines(
    { guildId: "guild-123", userId: "user-123" },
    createDependencies(rules),
  );

  assert.deepEqual(lines, [
    "### 許可されたチャンネルとスレッド",
    "ギルド全体: 許可",
    "・#general（許可）",
    "　└ #owners（オーナーのみ）",
    "・#private / #visible（許可）",
  ]);
});

test("reports when no channel or thread is explicitly allowed", async () => {
  const noRules = await buildAllowedDiscordChannelLines(
    { guildId: "guild-123", userId: "user-123" },
    createDependencies(undefined),
  );
  assert.match(noRules.join("\n"), /明示的に許可されたチャンネルやスレッドはありません/u);

  const denyGuild = await buildAllowedDiscordChannelLines(
    { guildId: "guild-123", userId: "user-123" },
    createDependencies({ access: "deny" }),
  );
  assert.match(denyGuild.join("\n"), /明示的に許可されたチャンネルやスレッドはありません/u);

  const allowGuild = await buildAllowedDiscordChannelLines(
    { guildId: "guild-123", userId: "user-123" },
    createDependencies({ access: "allow" }),
  );
  assert.match(allowGuild.join("\n"), /個別に許可されたチャンネルやスレッドはありません/u);
});
