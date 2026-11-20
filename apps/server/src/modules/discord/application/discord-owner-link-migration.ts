import type { Logger } from "pino";

import type {
  DiscordAccessRuleStore,
  DiscordAccessRuleTarget,
} from "../ports/discord-access-rule-store";
import type { DiscordChannelLinkStore } from "../ports/discord-channel-link-store";

export interface DiscordOwnerLinkMigrationDependencies {
  readonly accessRuleStore: Pick<DiscordAccessRuleStore, "setAccess"> & {
    listOwnerTargets?: () => readonly DiscordAccessRuleTarget[];
    listGuildOwnerIds?: () => readonly string[];
  };
  readonly channelLinkStore: Pick<DiscordChannelLinkStore, "getLink" | "saveLink">;
  readonly ownerUserId?: string;
  readonly logger?: Pick<Logger, "warn">;
}

/**
 * Turns legacy `owner` channel and thread rules into links to the configured
 * owner. Rewriting the rule to `allow` makes the migration idempotent, so an
 * unlinked channel is not adopted again on the next start.
 */
export async function migrateOwnerAccessToLinks(
  dependencies: DiscordOwnerLinkMigrationDependencies,
): Promise<void> {
  const ownerUserId = dependencies.ownerUserId;
  if (!ownerUserId) return;

  for (const guildId of dependencies.accessRuleStore.listGuildOwnerIds?.() ?? []) {
    dependencies.logger?.warn(
      { event: "discord_guild_owner_rule_remaining", guildId },
      "Guild-wide owner access is still configured; link individual channels to move it to links",
    );
  }

  for (const target of dependencies.accessRuleStore.listOwnerTargets?.() ?? []) {
    try {
      const existingLink = dependencies.channelLinkStore.getLink(target);
      if (!existingLink) {
        await dependencies.channelLinkStore.saveLink({
          ...target,
          userId: ownerUserId,
          linkedAt: new Date().toISOString(),
        });
      } else if (existingLink.userId !== ownerUserId) {
        dependencies.logger?.warn(
          {
            event: "discord_owner_rule_link_conflict",
            guildId: target.guildId,
            channelId: target.channelId,
            threadId: target.threadId,
            linkedUserId: existingLink.userId,
          },
          "A legacy owner rule points at a channel linked to another user; the link takes precedence",
        );
      }
    } catch (error) {
      dependencies.logger?.warn(
        {
          err: error,
          event: "discord_owner_rule_link_migration_failed",
          guildId: target.guildId,
          channelId: target.channelId,
          threadId: target.threadId,
        },
        "Failed to link a legacy owner channel",
      );
      continue;
    }

    try {
      await dependencies.accessRuleStore.setAccess(target, "allow");
    } catch (error) {
      dependencies.logger?.warn(
        {
          err: error,
          event: "discord_owner_rule_rewrite_failed",
          guildId: target.guildId,
          channelId: target.channelId,
          threadId: target.threadId,
        },
        "Failed to rewrite a legacy owner access rule",
      );
    }
  }
}
