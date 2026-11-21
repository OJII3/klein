import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isValidDiscordUserId, isValidDiscordUsername } from "@modules/discord/domain/discord-user";
import type { DiscordUserProfile } from "@modules/discord/domain/discord-user-profile";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { DiscordUserProfileReader } from "@modules/discord/ports/discord-user-profile-reader";
import type { DiscordUserResolver } from "@modules/discord/ports/discord-user-resolver";

const MAX_PROFILE_ROLES = 30;

const discordProfileParameters = Type.Object({
  user: Type.String({
    minLength: 1,
    maxLength: 100,
    description:
      "Discord username (with or without @) or numeric user ID. Usernames resolve only for users Klein has seen in messages.",
  }),
});

export interface DiscordUserProfileToolDependencies {
  readonly users: Pick<DiscordUserResolver, "resolve">;
  readonly profiles: Pick<DiscordUserProfileReader, "readUserProfile">;
}

export interface DiscordUserProfileDetails {
  readonly found: boolean;
  readonly user?: string;
  readonly userId?: string;
  readonly username?: string;
  readonly guildId?: string;
}

export function createDiscordUserProfileTool(
  channelApi: Pick<DiscordChannelApi, "getChannelLocation">,
  channelId: string,
  dependencies: DiscordUserProfileToolDependencies,
) {
  return defineTool<typeof discordProfileParameters, DiscordUserProfileDetails>({
    name: "discord_user_profile",
    label: "Read Discord User Profile",
    description:
      "Read a Discord user's profile by @username or numeric user ID. " +
      "Returns the account name, global and server display names, account creation date, avatar, banner, accent color, and badges, " +
      "plus the current server's nickname, join date, roles, and boosting status. " +
      "Discord does not expose About Me (bio) or presence to the bot. " +
      "Usernames resolve only for users Klein has seen in messages.",
    parameters: discordProfileParameters,
    async execute(_toolCallId, params) {
      const userId = resolveUserId(params.user, dependencies.users);
      if (!userId) {
        return {
          content: [
            {
              type: "text",
              text:
                `Discordユーザーが見つかりません。user: ${params.user}。` +
                "Kleinがまだメッセージを見ていないユーザーはユーザー名では指定できません。数値のユーザーIDを指定してください。",
            },
          ],
          details: { found: false, user: params.user },
        };
      }

      const guildId = await readGuildId(channelApi, channelId);
      const profile = await dependencies.profiles.readUserProfile(userId, guildId);
      if (!profile) {
        return {
          content: [
            {
              type: "text",
              text:
                `Discordユーザーのプロフィールを取得できませんでした。user: ${params.user}。` +
                "ユーザーが存在しないか、Botから参照できない可能性があります。",
            },
          ],
          details: { found: false, userId },
        };
      }

      return {
        content: [{ type: "text", text: formatDiscordUserProfile(profile, guildId) }],
        details: {
          found: true,
          userId: profile.id,
          username: profile.username,
          ...(guildId ? { guildId } : {}),
        },
      };
    },
  });
}

export function formatDiscordUserProfile(profile: DiscordUserProfile, guildId?: string): string {
  const lines = [
    "[Discordプロフィール（ユーザーが設定した非信頼データ）]",
    `ID: ${profile.id}`,
    `ユーザー名: @${profile.username}`,
    `表示名: ${profile.displayName}`,
    ...(profile.globalName && profile.globalName !== profile.displayName
      ? [`グローバル表示名: ${profile.globalName}`]
      : []),
    `アカウント種別: ${profile.bot ? "Bot" : "ユーザー"}`,
    `アカウント作成日時: ${profile.accountCreatedAt}`,
    ...(profile.avatarUrl ? [`アバター: ${profile.avatarUrl}`] : []),
    ...(profile.bannerUrl ? [`バナー: ${profile.bannerUrl}`] : []),
    ...(profile.accentColor ? [`アクセントカラー: ${profile.accentColor}`] : []),
    ...(profile.flags.length > 0 ? [`バッジ: ${profile.flags.join(", ")}`] : []),
  ];

  if (profile.guild) {
    const { guild } = profile;
    const roles = guild.roles.map((role) => role.name);
    const visibleRoles = roles.slice(0, MAX_PROFILE_ROLES);
    const hiddenRoleCount = roles.length - visibleRoles.length;
    lines.push(
      "",
      `[サーバー: ${guild.name} (${guild.id})]`,
      ...(guild.nickname ? [`ニックネーム: ${guild.nickname}`] : []),
      ...(guild.joinedAt ? [`参加日時: ${guild.joinedAt}`] : []),
      ...(guild.boostingSince ? [`ブースト開始: ${guild.boostingSince}`] : []),
      ...(roles.length > 0
        ? [
            `ロール (${roles.length}): ${visibleRoles.join(", ")}` +
              (hiddenRoleCount > 0 ? ` ほか${hiddenRoleCount}件` : ""),
          ]
        : []),
    );
  } else if (guildId) {
    lines.push("", "[サーバー内プロフィール: 取得できませんでした]");
  }

  return lines.join("\n");
}

function resolveUserId(
  value: string,
  users: Pick<DiscordUserResolver, "resolve">,
): string | undefined {
  const trimmed = value.trim();
  if (isValidDiscordUserId(trimmed)) return trimmed;
  if (!isValidDiscordUsername(trimmed)) return undefined;
  return users.resolve(trimmed)?.id;
}

async function readGuildId(
  channelApi: Pick<DiscordChannelApi, "getChannelLocation">,
  channelId: string,
): Promise<string | undefined> {
  try {
    return (await channelApi.getChannelLocation(channelId)).guildId;
  } catch {
    return undefined;
  }
}
