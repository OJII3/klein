import type {
  DiscordAccess,
  DiscordAccessTarget,
  DiscordGuildAccessRule,
} from "../domain/discord-access-policy";

const ACCESS_LABELS: Readonly<Record<DiscordAccess, string>> = {
  allow: "許可",
  deny: "拒否",
  owner: "オーナーのみ",
};

export interface DiscordAllowedChannelListDependencies {
  readonly getGuildRule: (guildId: string) => DiscordGuildAccessRule | undefined;
  readonly resolveAccess: (target: DiscordAccessTarget) => DiscordAccess;
  readonly resolveChannelName: (channelId: string) => Promise<string | undefined>;
  readonly resolveChannelOwner?: (target: {
    readonly channelId: string;
    readonly threadId?: string;
  }) => string | undefined;
}

function formatAccessLabel(access: DiscordAccess, ownerId: string | undefined): string {
  const label = ACCESS_LABELS[access];
  return ownerId ? `${label}、<@${ownerId}> のチャンネル` : label;
}

export interface DiscordAllowedChannelListInput {
  readonly guildId: string;
  readonly userId: string;
  readonly userIsBot?: boolean;
}

/**
 * Builds the body of the `/channels` command. Only channels and threads whose
 * resolved access is not `deny` are listed.
 */
export async function buildAllowedDiscordChannelLines(
  input: DiscordAllowedChannelListInput,
  dependencies: DiscordAllowedChannelListDependencies,
): Promise<readonly string[]> {
  const guildRule = dependencies.getGuildRule(input.guildId);
  const resolve = (target: { channelId: string; threadId?: string }): DiscordAccess =>
    dependencies.resolveAccess({
      guildId: input.guildId,
      userId: input.userId,
      ...(input.userIsBot === undefined ? {} : { userIsBot: input.userIsBot }),
      ...target,
    });

  const lines: string[] = ["### 許可されたチャンネルとスレッド"];
  if (guildRule?.access) {
    lines.push(`ギルド全体: ${ACCESS_LABELS[guildRule.access]}`);
  }

  let listed = 0;
  for (const [channelId, channelRule] of Object.entries(guildRule?.channels ?? {})) {
    const channelAccess = resolve({ channelId });
    const channelAllowed = channelAccess !== "deny";
    const channelName = await dependencies.resolveChannelName(channelId);
    const channelReference = channelName ? `#${channelName}` : channelId;
    if (channelAllowed) {
      const ownerId = dependencies.resolveChannelOwner?.({ channelId });
      lines.push(`・${channelReference}（${formatAccessLabel(channelAccess, ownerId)}）`);
      listed += 1;
    }

    for (const threadId of Object.keys(channelRule.threads ?? {})) {
      const threadAccess = resolve({ channelId, threadId });
      if (threadAccess === "deny") continue;
      const threadName = await dependencies.resolveChannelName(threadId);
      const threadReference = threadName ? `#${threadName}` : threadId;
      const ownerId = dependencies.resolveChannelOwner?.({ channelId, threadId });
      const threadLabel = formatAccessLabel(threadAccess, ownerId);
      lines.push(
        channelAllowed
          ? `　└ ${threadReference}（${threadLabel}）`
          : `・${channelReference} / ${threadReference}（${threadLabel}）`,
      );
      listed += 1;
    }
  }

  if (listed === 0) {
    lines.push(
      guildRule?.access === "deny" || !guildRule
        ? "明示的に許可されたチャンネルやスレッドはありません。"
        : "個別に許可されたチャンネルやスレッドはありません。",
    );
  }

  return lines;
}
