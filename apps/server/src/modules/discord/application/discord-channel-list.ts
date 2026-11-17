import type {
  DiscordAccess,
  DiscordAccessTarget,
  DiscordGuildAccessRule,
} from "../domain/discord-access-policy";

const CONTAINER_TEXT_LIMIT = 4_000;
const ACCESS_LABELS: Readonly<Record<DiscordAccess, string>> = {
  allow: "許可",
  deny: "拒否",
  owner: "オーナーのみ",
};

export interface DiscordAllowedChannelListDependencies {
  readonly getGuildRule: (guildId: string) => DiscordGuildAccessRule | undefined;
  readonly resolveAccess: (target: DiscordAccessTarget) => DiscordAccess;
  readonly resolveChannelName: (channelId: string) => Promise<string | undefined>;
}

export interface DiscordAllowedChannelListInput {
  readonly guildId: string;
  readonly userId: string;
  readonly userIsBot?: boolean;
}

export function truncateDiscordContainerText(lines: readonly string[], limit: number): string {
  let text = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const candidate = text ? `${text}\n${line}` : line;
    if (candidate.length > limit) {
      const remaining = lines.length - index;
      return `${text}\n…ほか ${remaining} 件`;
    }
    text = candidate;
  }
  return text;
}

/**
 * Builds the body of the `/channels` command. Only channels and threads whose
 * resolved access is not `deny` are listed.
 */
export async function formatAllowedDiscordChannels(
  input: DiscordAllowedChannelListInput,
  dependencies: DiscordAllowedChannelListDependencies,
): Promise<string> {
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
      lines.push(`・${channelReference}（${ACCESS_LABELS[channelAccess]}）`);
      listed += 1;
    }

    for (const threadId of Object.keys(channelRule.threads ?? {})) {
      const threadAccess = resolve({ channelId, threadId });
      if (threadAccess === "deny") continue;
      const threadName = await dependencies.resolveChannelName(threadId);
      const threadReference = threadName ? `#${threadName}` : threadId;
      lines.push(
        channelAllowed
          ? `　└ ${threadReference}（${ACCESS_LABELS[threadAccess]}）`
          : `・${channelReference} / ${threadReference}（${ACCESS_LABELS[threadAccess]}）`,
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

  return truncateDiscordContainerText(lines, CONTAINER_TEXT_LIMIT);
}
