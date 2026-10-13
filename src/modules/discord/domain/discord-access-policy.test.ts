import assert from "node:assert/strict";
import test from "node:test";

import { createDiscordAccessPolicy } from "./discord-access-policy";

const policy = createDiscordAccessPolicy({
  default: "deny",
  directMessages: "allow",
  guilds: {
    guild: {
      access: "allow",
      channels: {
        denied: { access: "deny" },
        inherited: {
          threads: {
            allowed: { access: "allow" },
          },
        },
      },
    },
  },
});

test("uses directMessages for direct messages", () => {
  assert.equal(policy.canReceive({ channelId: "dm" }), true);
});

test("resolves guild access from guild to default", () => {
  assert.equal(policy.canReceive({ guildId: "guild", channelId: "other" }), true);
  assert.equal(policy.canReceive({ guildId: "other", channelId: "other" }), false);
});

test("resolves thread access after channel access", () => {
  assert.equal(
    policy.canReceive({ guildId: "guild", channelId: "denied", threadId: "other" }),
    false,
  );
  assert.equal(
    policy.canReceive({ guildId: "guild", channelId: "inherited", threadId: "allowed" }),
    true,
  );
  assert.equal(
    policy.canReceive({ guildId: "guild", channelId: "inherited", threadId: "other" }),
    true,
  );
});

const ownerPolicy = createDiscordAccessPolicy(
  {
    default: "deny",
    directMessages: "owner",
    guilds: {
      guild: {
        access: "owner",
        channels: {
          public: { access: "allow" },
          private: {
            threads: {
              public: { access: "allow" },
              denied: { access: "deny" },
            },
          },
        },
      },
    },
  },
  "owner-user",
);

test("owner access requires the configured owner and rejects bots and missing identity", () => {
  const target = { guildId: "guild", channelId: "private" };
  assert.equal(ownerPolicy.resolveAccess(target), "owner");
  for (const identity of [
    {},
    { userId: "other-user" },
    { userId: "owner-user", userIsBot: true },
  ]) {
    assert.equal(ownerPolicy.canReceive({ ...target, ...identity }), false);
    assert.equal(ownerPolicy.canUseOwnerFeatures({ ...target, ...identity }), false);
  }
  assert.equal(ownerPolicy.canReceive({ ...target, userId: "owner-user" }), true);
  assert.equal(ownerPolicy.canUseOwnerFeatures({ ...target, userId: "owner-user" }), true);
});

test("owner access inherits existing rules and only owner access grants owner features", () => {
  const owner = { userId: "owner-user" };
  assert.equal(ownerPolicy.canReceive({ channelId: "dm", ...owner }), true);
  assert.equal(
    ownerPolicy.canReceive({
      guildId: "guild",
      channelId: "private",
      threadId: "inherited",
      ...owner,
    }),
    true,
  );
  for (const target of [
    { guildId: "guild", channelId: "public" },
    { guildId: "guild", channelId: "private", threadId: "public" },
  ]) {
    assert.equal(ownerPolicy.canReceive(target), true);
    assert.equal(ownerPolicy.canUseOwnerFeatures({ ...target, ...owner }), false);
  }
  assert.equal(
    ownerPolicy.canReceive({
      guildId: "guild",
      channelId: "private",
      threadId: "denied",
      ...owner,
    }),
    false,
  );
  assert.equal(ownerPolicy.canReceive({ guildId: "other", channelId: "private", ...owner }), false);
});

test("owner access rejects requests when no owner is configured", () => {
  const unconfigured = createDiscordAccessPolicy({ default: "owner", directMessages: "owner" });
  assert.equal(unconfigured.canReceive({ channelId: "dm", userId: "owner-user" }), false);
  assert.equal(unconfigured.canUseOwnerFeatures({ channelId: "dm", userId: "owner-user" }), false);
});
