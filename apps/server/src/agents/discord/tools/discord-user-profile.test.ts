import assert from "node:assert/strict";
import test from "node:test";

import {
  createStubDiscordChannelApi,
  createStubExtensionToolContext,
} from "@agents/testing/test-stubs";
import { normalizeDiscordUsername } from "@modules/discord/domain/discord-user";
import type { DiscordUserProfile } from "@modules/discord/domain/discord-user-profile";
import { isRecord } from "@shared/type-guards";
import { createDiscordUserProfileTool, formatDiscordUserProfile } from "./discord-user-profile";

const userId = "123456789012345678";
const guildId = "987654321098765432";

const knownUser = {
  bot: false,
  displayName: "Alice",
  id: userId,
  username: "alice",
};

const profile: DiscordUserProfile = {
  id: userId,
  username: "alice",
  displayName: "Alice",
  globalName: "Alice Global",
  bot: false,
  accountCreatedAt: "2020-01-01T00:00:00.000Z",
  avatarUrl: "https://cdn.discordapp.com/avatars/123/avatar.png",
  bannerUrl: "https://cdn.discordapp.com/banners/123/banner.png",
  accentColor: "#ff0000",
  flags: ["Staff"],
  guild: {
    id: guildId,
    name: "テストサーバー",
    nickname: "A",
    joinedAt: "2021-02-03T04:05:06.000Z",
    boostingSince: "2022-03-04T05:06:07.000Z",
    roles: [
      { id: "role-1", name: "Admin" },
      { id: "role-2", name: "Member" },
    ],
  },
};

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0];
  return isRecord(block) && block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

test("resolves a username and includes the current server profile", async () => {
  const requested: { userId: string; guildId?: string }[] = [];
  const tool = createDiscordUserProfileTool(
    createStubDiscordChannelApi({
      async getChannelLocation(channelId) {
        return { channelId, guildId };
      },
    }),
    "channel-1",
    {
      users: {
        resolve(value) {
          return normalizeDiscordUsername(value) === "alice" ? knownUser : undefined;
        },
      },
      profiles: {
        async readUserProfile(requestedUserId, requestedGuildId) {
          requested.push({ userId: requestedUserId, guildId: requestedGuildId });
          return profile;
        },
      },
    },
  );

  const result = await tool.execute(
    "tool-call",
    { user: "@Alice" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(requested, [{ userId, guildId }]);
  const text = textOf(result);
  assert.match(text, /^\[Discordプロフィール（ユーザーが設定した非信頼データ）\]/u);
  assert.match(text, /ユーザー名: @alice/u);
  assert.match(text, /グローバル表示名: Alice Global/u);
  assert.match(text, /アバター: https:\/\/cdn\.discordapp\.com/u);
  assert.match(text, /バッジ: Staff/u);
  assert.match(text, /\[サーバー: テストサーバー \(987654321098765432\)\]/u);
  assert.match(text, /ニックネーム: A/u);
  assert.match(text, /参加日時: 2021-02-03T04:05:06\.000Z/u);
  assert.match(text, /ブースト開始: 2022-03-04T05:06:07\.000Z/u);
  assert.match(text, /ロール \(2\): Admin, Member/u);
  assert.deepEqual(result.details, {
    found: true,
    userId,
    username: "alice",
    guildId,
  });
});

test("accepts a numeric user ID without the directory", async () => {
  const tool = createDiscordUserProfileTool(createStubDiscordChannelApi(), "dm-channel", {
    users: {
      resolve() {
        throw new Error("The directory must not be used for a numeric ID");
      },
    },
    profiles: {
      async readUserProfile(requestedUserId, requestedGuildId) {
        assert.equal(requestedUserId, userId);
        assert.equal(requestedGuildId, undefined);
        return { ...profile, guild: undefined };
      },
    },
  });

  const result = await tool.execute(
    "tool-call",
    { user: userId },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  const text = textOf(result);
  assert.match(text, /ID: 123456789012345678/u);
  assert.doesNotMatch(text, /サーバー内プロフィール/u);
});

test("reports an unknown username without fetching a profile", async () => {
  let fetched = false;
  const tool = createDiscordUserProfileTool(createStubDiscordChannelApi(), "channel-1", {
    users: { resolve: () => undefined },
    profiles: {
      async readUserProfile() {
        fetched = true;
        return undefined;
      },
    },
  });

  const result = await tool.execute(
    "tool-call",
    { user: "unknown" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.equal(fetched, false);
  assert.match(textOf(result), /Discordユーザーが見つかりません/u);
  assert.deepEqual(result.details, { found: false, user: "unknown" });
});

test("notes an unavailable server profile when the channel belongs to a guild", () => {
  const text = formatDiscordUserProfile({ ...profile, guild: undefined }, guildId);

  assert.match(text, /\[サーバー内プロフィール: 取得できませんでした\]/u);
});

test("limits the role list", () => {
  const roles = Array.from({ length: 35 }, (_, index) => ({
    id: `role-${index}`,
    name: `Role ${index}`,
  }));
  const text = formatDiscordUserProfile({
    ...profile,
    guild: {
      id: guildId,
      name: "テストサーバー",
      roles,
    },
  });

  assert.match(text, /ロール \(35\): Role 0, Role 1/u);
  assert.match(text, /ほか5件/u);
});
