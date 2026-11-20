import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiscordAccessPolicy,
  type DiscordAccessRules,
  type DiscordGuildAccessRule,
} from "./discord-access-policy";

function createRules(guilds: Record<string, DiscordGuildAccessRule>): DiscordAccessRules {
  return { getGuildRule: (guildId) => guilds[guildId] };
}

const rules = createRules({
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
});

const policy = createDiscordAccessPolicy(
  {
    default: "deny",
    directMessages: "allow",
  },
  undefined,
  rules,
);

test("uses directMessages for direct messages", () => {
  assert.equal(policy.canReceive({ channelId: "dm" }), true);
});

test("always allows the owner to direct message and use owner features", () => {
  for (const directMessages of ["allow", "deny", "owner"] as const) {
    const dmPolicy = createDiscordAccessPolicy({ default: "deny", directMessages }, "owner-user");
    assert.equal(dmPolicy.canReceive({ channelId: "dm", userId: "owner-user" }), true);
    assert.equal(dmPolicy.canUseOwnerFeatures({ channelId: "dm", userId: "owner-user" }), true);
    assert.equal(
      dmPolicy.canReceive({ channelId: "dm", userId: "other-user" }),
      directMessages === "allow",
    );
    assert.equal(dmPolicy.canUseOwnerFeatures({ channelId: "dm", userId: "other-user" }), false);
  }
});

test("does not treat a bot owner as the owner in direct messages", () => {
  const dmPolicy = createDiscordAccessPolicy(
    { default: "deny", directMessages: "deny" },
    "owner-user",
  );
  assert.equal(
    dmPolicy.canReceive({ channelId: "dm", userId: "owner-user", userIsBot: true }),
    false,
  );
  assert.equal(
    dmPolicy.canUseOwnerFeatures({ channelId: "dm", userId: "owner-user", userIsBot: true }),
    false,
  );
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
  },
  "owner-user",
  createRules({
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
  }),
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

const links: Readonly<Record<string, string>> = {
  "guild:owner-channel": "owner-user",
  "guild:member-channel": "member-user",
  "guild:parent:owner-thread": "owner-user",
};

const linkedPolicy = createDiscordAccessPolicy(
  { default: "deny", directMessages: "deny" },
  "owner-user",
  createRules({
    guild: {
      access: "deny",
      channels: {
        "owner-channel": { access: "deny" },
        "member-channel": { access: "owner" },
        parent: { access: "owner" },
      },
    },
  }),
  (target) =>
    links[`${target.guildId}:${target.channelId}${target.threadId ? `:${target.threadId}` : ""}`],
);

test("a link to the configured owner makes the location owner-only", () => {
  const target = { guildId: "guild", channelId: "owner-channel" };
  assert.equal(linkedPolicy.resolveAccess(target), "owner");
  assert.equal(linkedPolicy.canReceive({ ...target, userId: "owner-user" }), true);
  assert.equal(linkedPolicy.canUseOwnerFeatures({ ...target, userId: "owner-user" }), true);
  assert.equal(linkedPolicy.canReceive({ ...target, userId: "member-user" }), false);
  assert.equal(linkedPolicy.canUseOwnerFeatures({ ...target, userId: "member-user" }), false);
});

test("a link to another user allows everyone but grants no owner features", () => {
  const target = { guildId: "guild", channelId: "member-channel" };
  assert.equal(linkedPolicy.resolveAccess(target), "allow");
  assert.equal(linkedPolicy.canReceive({ ...target, userId: "member-user" }), true);
  assert.equal(linkedPolicy.canReceive({ ...target, userId: "stranger" }), true);
  assert.equal(linkedPolicy.canUseOwnerFeatures({ ...target, userId: "owner-user" }), false);
  assert.equal(linkedPolicy.canUseOwnerFeatures({ ...target, userId: "member-user" }), false);
});

test("a thread link takes precedence over the parent channel rules", () => {
  const target = { guildId: "guild", channelId: "parent", threadId: "owner-thread" };
  assert.equal(linkedPolicy.resolveAccess(target), "owner");
  assert.equal(linkedPolicy.canReceive({ ...target, userId: "owner-user" }), true);
  assert.equal(linkedPolicy.canReceive({ ...target, userId: "member-user" }), false);
});

test("unlinked locations still use the access rules", () => {
  assert.equal(linkedPolicy.resolveAccess({ guildId: "guild", channelId: "unknown" }), "deny");
  assert.equal(
    linkedPolicy.canReceive({ guildId: "guild", channelId: "unknown", userId: "owner-user" }),
    false,
  );
});
