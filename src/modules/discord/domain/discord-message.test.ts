import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDiscordUser,
  resolveDiscordMentions,
  type DiscordRole,
  type DiscordUser,
} from "./discord-message.js";

const user: DiscordUser = {
  id: "123456789012345678",
  username: "satsuki",
  displayName: "さつき",
};

const bot: DiscordUser = {
  id: "987654321098765432",
  username: "klein",
  displayName: "クライン",
};

const role: DiscordRole = {
  id: "111111111111111111",
  name: "開発チーム",
};

test("formats a Discord user with display name and username", () => {
  assert.equal(formatDiscordUser(user), "さつき (@satsuki)");
});

test("does not duplicate a username used as the display name", () => {
  assert.equal(formatDiscordUser({ ...user, displayName: user.username }), "satsuki");
});

test("resolves user mentions without changing unrelated numbers", () => {
  assert.equal(
    resolveDiscordMentions(
      "こんにちは <@123456789012345678>。注文番号は123456です。<@!999999999999999999>",
      {
        user: (userId) => (userId === user.id ? user : undefined),
        role: () => undefined,
      },
    ),
    "こんにちは @さつき (@satsuki)。注文番号は123456です。<@!999999999999999999>",
  );
});

test("resolves bot mentions like any other user mention", () => {
  assert.equal(
    resolveDiscordMentions("<@987654321098765432> これを教えて", {
      user: (userId) => (userId === bot.id ? bot : undefined),
      role: () => undefined,
    }),
    "@クライン (@klein) これを教えて",
  );
});

test("resolves role mentions without changing unrelated numbers", () => {
  assert.equal(
    resolveDiscordMentions("<@&111111111111111111> の番号は123456です。<@&999999999999999999>", {
      user: () => undefined,
      role: (roleId) => (roleId === role.id ? role : undefined),
    }),
    "@開発チーム の番号は123456です。<@&999999999999999999>",
  );
});
