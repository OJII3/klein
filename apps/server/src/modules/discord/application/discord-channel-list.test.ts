import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiscordAccessPolicy,
  type DiscordGuildAccessRule,
} from "../domain/discord-access-policy";
import {
  formatAllowedDiscordChannels,
  truncateDiscordContainerText,
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
  const text = await formatAllowedDiscordChannels(
    { guildId: "guild-123", userId: "user-123" },
    createDependencies(rules),
  );

  assert.equal(
    text,
    [
      "### 許可されたチャンネルとスレッド",
      "ギルド全体: 許可",
      "・#general（許可）",
      "　└ #owners（オーナーのみ）",
      "・#private / #visible（許可）",
    ].join("\n"),
  );
});

test("reports when no channel or thread is explicitly allowed", async () => {
  const noRules = await formatAllowedDiscordChannels(
    { guildId: "guild-123", userId: "user-123" },
    createDependencies(undefined),
  );
  assert.match(noRules, /明示的に許可されたチャンネルやスレッドはありません/u);

  const denyGuild = await formatAllowedDiscordChannels(
    { guildId: "guild-123", userId: "user-123" },
    createDependencies({ access: "deny" }),
  );
  assert.match(denyGuild, /明示的に許可されたチャンネルやスレッドはありません/u);

  const allowGuild = await formatAllowedDiscordChannels(
    { guildId: "guild-123", userId: "user-123" },
    createDependencies({ access: "allow" }),
  );
  assert.match(allowGuild, /個別に許可されたチャンネルやスレッドはありません/u);
});

test("truncates long lists and reports the remaining line count", () => {
  assert.equal(truncateDiscordContainerText(["a", "b", "c"], 2), "a\n…ほか 2 件");
  assert.equal(truncateDiscordContainerText(["a", "b"], 10), "a\nb");
});
