import assert from "node:assert/strict";
import test from "node:test";

import type { DiscordChannelLink } from "../domain/discord-channel-link";
import type { DiscordAccessRuleTarget } from "../ports/discord-access-rule-store";
import { migrateOwnerAccessToLinks } from "./discord-owner-link-migration";

function linkKey(target: DiscordAccessRuleTarget): string {
  return `${target.guildId}:${target.channelId}:${target.threadId ?? ""}`;
}

function createHarness(
  options: {
    ownerUserId?: string;
    guildOwnerIds?: readonly string[];
    ownerTargets?: readonly DiscordAccessRuleTarget[];
    existingLink?: DiscordChannelLink;
    failLinkSave?: boolean;
    failAccessUpdate?: boolean;
  } = {},
) {
  const links = new Map<string, DiscordChannelLink>();
  if (options.existingLink) {
    links.set(linkKey(options.existingLink), options.existingLink);
  }
  const updated: Array<{ target: DiscordAccessRuleTarget; access: string }> = [];
  const warnings: Array<{ event?: string }> = [];

  return {
    links,
    updated,
    warnings,
    dependencies: {
      ownerUserId: options.ownerUserId ?? "owner-123",
      accessRuleStore: {
        listGuildOwnerIds: () => options.guildOwnerIds ?? [],
        listOwnerTargets: () => options.ownerTargets ?? [],
        setAccess: async (target: DiscordAccessRuleTarget, access: string) => {
          if (options.failAccessUpdate) throw new Error("write failed");
          updated.push({ target, access });
        },
      },
      channelLinkStore: {
        getLink: (target: DiscordAccessRuleTarget) => links.get(linkKey(target)),
        saveLink: async (link: DiscordChannelLink) => {
          if (options.failLinkSave) throw new Error("write failed");
          links.set(linkKey(link), link);
        },
      },
      logger: {
        warn: (...args: unknown[]) => {
          const [context] = args;
          if (context && typeof context === "object" && "event" in context) {
            warnings.push({ event: String(context.event) });
          }
        },
      },
    },
  };
}

const target: DiscordAccessRuleTarget = {
  guildId: "guild-123",
  channelId: "channel-123",
};

test("does nothing when no owner is configured", async () => {
  const harness = createHarness({ ownerUserId: undefined, ownerTargets: [target] });

  await migrateOwnerAccessToLinks({
    ...harness.dependencies,
    ownerUserId: undefined,
  });

  assert.equal(harness.links.size, 0);
  assert.deepEqual(harness.updated, []);
});

test("links legacy owner channels to the owner and rewrites the rules", async () => {
  const harness = createHarness({
    ownerTargets: [
      { guildId: "guild-123", channelId: "channel-123" },
      { guildId: "guild-123", channelId: "parent-123", threadId: "thread-123" },
    ],
  });

  await migrateOwnerAccessToLinks(harness.dependencies);

  assert.deepEqual(
    [...harness.links.values()].map(({ guildId, channelId, threadId, userId }) => ({
      guildId,
      channelId,
      threadId,
      userId,
    })),
    [
      { guildId: "guild-123", channelId: "channel-123", threadId: undefined, userId: "owner-123" },
      {
        guildId: "guild-123",
        channelId: "parent-123",
        threadId: "thread-123",
        userId: "owner-123",
      },
    ],
  );
  assert.deepEqual(harness.updated, [
    { target: { guildId: "guild-123", channelId: "channel-123" }, access: "allow" },
    {
      target: { guildId: "guild-123", channelId: "parent-123", threadId: "thread-123" },
      access: "allow",
    },
  ]);
});

test("does not replace an existing link but still rewrites the rule", async () => {
  const existing: DiscordChannelLink = {
    guildId: "guild-123",
    channelId: "channel-123",
    userId: "member-123",
    linkedAt: "2026-01-01T00:00:00.000Z",
  };
  const harness = createHarness({ ownerTargets: [target], existingLink: existing });

  await migrateOwnerAccessToLinks(harness.dependencies);

  assert.deepEqual([...harness.links.values()], [existing]);
  assert.deepEqual(harness.updated, [{ target, access: "allow" }]);
});

test("warns about guild-wide owner access", async () => {
  const harness = createHarness({ guildOwnerIds: ["guild-123"] });

  await migrateOwnerAccessToLinks(harness.dependencies);

  assert.deepEqual(
    harness.warnings.map(({ event }) => event),
    ["discord_guild_owner_rule_remaining"],
  );
});

test("keeps the legacy rule when the link cannot be saved", async () => {
  const harness = createHarness({ ownerTargets: [target], failLinkSave: true });

  await migrateOwnerAccessToLinks(harness.dependencies);

  assert.deepEqual(harness.updated, []);
  assert.deepEqual(
    harness.warnings.map(({ event }) => event),
    ["discord_owner_rule_link_migration_failed"],
  );
});

test("continues when a legacy rule cannot be rewritten", async () => {
  const harness = createHarness({
    ownerTargets: [target, { guildId: "guild-123", channelId: "channel-456" }],
    failAccessUpdate: true,
  });

  await migrateOwnerAccessToLinks(harness.dependencies);

  assert.equal(harness.links.size, 2);
  assert.deepEqual(
    harness.warnings.map(({ event }) => event),
    ["discord_owner_rule_rewrite_failed", "discord_owner_rule_rewrite_failed"],
  );
});
