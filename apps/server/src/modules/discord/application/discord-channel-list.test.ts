import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiscordAccessPolicy,
  type DiscordGuildAccessRule,
} from "../domain/discord-access-policy";
import type { DiscordChannelLink } from "../domain/discord-channel-link";
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
  "linked-channel": "linked",
  "linked-thread": "linked-thread",
  "owner-channel": "owner-only",
};

function createDependencies(
  guildRule: DiscordGuildAccessRule | undefined,
  owners: Readonly<Record<string, string>> = {},
  links: readonly DiscordChannelLink[] = [],
): DiscordAllowedChannelListDependencies {
  const accessPolicy = createDiscordAccessPolicy(
    { default: "deny", directMessages: "deny" },
    "owner-123",
    { getGuildRule: (guildId) => (guildId === "guild-123" ? guildRule : undefined) },
    (target) => owners[target.threadId ?? target.channelId],
  );

  return {
    getGuildRule: (guildId: string) => (guildId === "guild-123" ? guildRule : undefined),
    resolveAccess: (target) => accessPolicy.resolveAccess(target),
    resolveChannelName: async (channelId: string) => names[channelId],
    resolveChannelOwner: (target) => owners[target.threadId ?? target.channelId],
    listChannelLinks: () => links,
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

test("shows the registered user next to a linked channel", async () => {
  const links: DiscordChannelLink[] = [
    {
      guildId: "guild-123",
      channelId: "channel-1",
      userId: "user-1",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      guildId: "guild-123",
      channelId: "channel-2",
      threadId: "thread-3",
      userId: "user-3",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const lines = await buildAllowedDiscordChannelLines(
    { guildId: "guild-123", userId: "user-123" },
    createDependencies(rules, { "channel-1": "user-1", "thread-3": "user-3" }, links),
  );

  assert.deepEqual(lines, [
    "### 許可されたチャンネルとスレッド",
    "ギルド全体: 許可",
    "・#general（許可、<@user-1> のチャンネル）",
    "　└ #owners（オーナーのみ）",
    "・#private / #visible（許可、<@user-3> のチャンネル）",
  ]);
});

test("lists linked channels and threads without an explicit access rule", async () => {
  const links: DiscordChannelLink[] = [
    {
      guildId: "guild-123",
      channelId: "linked-channel",
      userId: "user-1",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      guildId: "guild-123",
      channelId: "linked-thread-parent",
      threadId: "linked-thread",
      userId: "user-2",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      guildId: "guild-123",
      channelId: "owner-channel",
      userId: "owner-123",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const lines = await buildAllowedDiscordChannelLines(
    { guildId: "guild-123", userId: "user-123" },
    createDependencies(
      undefined,
      {
        "linked-channel": "user-1",
        "linked-thread": "user-2",
        "owner-channel": "owner-123",
      },
      links,
    ),
  );

  assert.deepEqual(lines, [
    "### 許可されたチャンネルとスレッド",
    "・#linked（許可、<@user-1> のチャンネル）",
    "・#linked-thread（許可、<@user-2> のチャンネル）",
    "・#owner-only（オーナーのみ、<@owner-123> のチャンネル）",
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
