import assert from "node:assert/strict";
import test from "node:test";

import {
  toDiscordUserProfile,
  type DiscordServiceProfileGuildMember,
  type DiscordServiceProfileUser,
} from "./discord-js-user-profile";

const userId = "123456789012345678";
const guildId = "987654321098765432";

function createUser(overrides: Partial<DiscordServiceProfileUser> = {}): DiscordServiceProfileUser {
  return {
    id: userId,
    username: "alice",
    globalName: "Alice Global",
    displayName: "Alice",
    bot: false,
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    hexAccentColor: "#abcdef",
    flags: { toArray: () => ["Staff"] },
    avatarURL(options) {
      assert.equal(options?.size, 256);
      return "https://cdn.discordapp.com/avatars/123/avatar.png";
    },
    bannerURL() {
      return "https://cdn.discordapp.com/banners/123/banner.png";
    },
    ...overrides,
  };
}

function createMember(
  overrides: Partial<DiscordServiceProfileGuildMember> = {},
): DiscordServiceProfileGuildMember {
  return {
    nickname: "A",
    displayName: "A",
    joinedAt: new Date("2021-02-03T04:05:06.000Z"),
    premiumSince: new Date("2022-03-04T05:06:07.000Z"),
    roles: {
      cache: new Map([
        [guildId, { id: guildId, name: "@everyone", position: 0 }],
        ["role-admin", { id: "role-admin", name: "Admin", position: 10 }],
        ["role-member", { id: "role-member", name: "Member", position: 5 }],
      ]),
    },
    ...overrides,
  };
}

test("maps the global profile and the current server profile", () => {
  const profile = toDiscordUserProfile({
    user: createUser(),
    guild: { id: guildId, name: "テストサーバー", members: { fetch: async () => createMember() } },
    member: createMember(),
  });

  assert.deepEqual(profile, {
    id: userId,
    username: "alice",
    displayName: "A",
    globalName: "Alice Global",
    bot: false,
    accountCreatedAt: "2020-01-01T00:00:00.000Z",
    avatarUrl: "https://cdn.discordapp.com/avatars/123/avatar.png",
    bannerUrl: "https://cdn.discordapp.com/banners/123/banner.png",
    accentColor: "#abcdef",
    flags: ["Staff"],
    guild: {
      id: guildId,
      name: "テストサーバー",
      nickname: "A",
      joinedAt: "2021-02-03T04:05:06.000Z",
      boostingSince: "2022-03-04T05:06:07.000Z",
      roles: [
        { id: "role-admin", name: "Admin" },
        { id: "role-member", name: "Member" },
      ],
    },
  });
});

test("omits absent optional fields", () => {
  const profile = toDiscordUserProfile({
    user: createUser({
      globalName: null,
      hexAccentColor: null,
      flags: null,
      avatarURL: () => null,
      bannerURL: () => undefined,
    }),
  });

  assert.deepEqual(profile, {
    id: userId,
    username: "alice",
    displayName: "Alice",
    bot: false,
    accountCreatedAt: "2020-01-01T00:00:00.000Z",
    flags: [],
  });
});
