import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDiscordUser,
  resolveDiscordUserMentions,
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

test("formats a Discord user with display name and username", () => {
  assert.equal(formatDiscordUser(user), "さつき (@satsuki)");
});

test("does not duplicate a username used as the display name", () => {
  assert.equal(formatDiscordUser({ ...user, displayName: user.username }), "satsuki");
});

test("resolves user mentions without changing unrelated numbers", () => {
  assert.equal(
    resolveDiscordUserMentions(
      "こんにちは <@123456789012345678>。注文番号は123456です。<@!999999999999999999>",
      (userId) => (userId === user.id ? user : undefined),
    ),
    "こんにちは @さつき (@satsuki)。注文番号は123456です。<@!999999999999999999>",
  );
});

test("resolves bot mentions like any other user mention", () => {
  assert.equal(
    resolveDiscordUserMentions("<@987654321098765432> これを教えて", (userId) =>
      userId === bot.id ? bot : undefined,
    ),
    "@クライン (@klein) これを教えて",
  );
});
