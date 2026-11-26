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
      access: "allow",
      channels: {
        public: { access: "allow" },
      },
    },
  }),
  (target) =>
    target.guildId === "guild" && target.channelId === "private" ? "owner-user" : undefined,
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
        "member-channel": { access: "deny" },
        parent: { access: "deny" },
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

test("a linked user owns the private session for their own channel", () => {
  const target = { guildId: "guild", channelId: "member-channel" };
  assert.equal(linkedPolicy.resolveLinkedUser({ ...target, userId: "member-user" }), "member-user");
  assert.equal(linkedPolicy.resolveLinkedUser({ ...target, userId: "stranger" }), undefined);
  assert.equal(
    linkedPolicy.resolveLinkedUser({ ...target, userId: "member-user", userIsBot: true }),
    undefined,
  );
  assert.equal(
    linkedPolicy.resolveLinkedUser({
      guildId: "guild",
      channelId: "unknown",
      userId: "member-user",
    }),
    undefined,
  );
});

test("a thread link resolves its linked user", () => {
  const target = { guildId: "guild", channelId: "parent", threadId: "owner-thread" };
  assert.equal(linkedPolicy.resolveLinkedUser({ ...target, userId: "owner-user" }), "owner-user");
  assert.equal(linkedPolicy.resolveLinkedUser({ ...target, userId: "member-user" }), undefined);
});

test("unlinked locations still use the access rules", () => {
  assert.equal(linkedPolicy.resolveAccess({ guildId: "guild", channelId: "unknown" }), "deny");
  assert.equal(
    linkedPolicy.canReceive({ guildId: "guild", channelId: "unknown", userId: "owner-user" }),
    false,
  );
});

test("admits a non-owner human in an owner channel as a bystander", () => {
  const target = { guildId: "guild", channelId: "owner-channel" };

  assert.equal(linkedPolicy.resolveAdmission({ ...target, userId: "owner-user" }), "owner");
  assert.equal(linkedPolicy.resolveAdmission({ ...target, userId: "member-user" }), "bystander");
  assert.equal(linkedPolicy.canReceiveMessage({ ...target, userId: "member-user" }), true);
  assert.equal(linkedPolicy.canReceive({ ...target, userId: "member-user" }), false);
});

test("keeps bots and deny rules out on the message path", () => {
  assert.equal(
    linkedPolicy.resolveAdmission({
      guildId: "guild",
      channelId: "owner-channel",
      userId: "member-user",
      userIsBot: true,
    }),
    "denied",
  );
  assert.equal(
    linkedPolicy.canReceiveMessage({
      guildId: "guild",
      channelId: "owner-channel",
      userId: "member-user",
      userIsBot: true,
    }),
    false,
  );
  assert.equal(
    linkedPolicy.resolveAdmission({
      guildId: "guild",
      channelId: "unknown",
      userId: "member-user",
    }),
    "denied",
  );
  assert.equal(
    linkedPolicy.canReceiveMessage({
      guildId: "guild",
      channelId: "unknown",
      userId: "member-user",
    }),
    false,
  );
});

test("keeps non-owner direct messages denied on the message path", () => {
  const ownerDmPolicy = createDiscordAccessPolicy(
    { default: "deny", directMessages: "owner" },
    "owner-user",
  );

  assert.equal(ownerDmPolicy.resolveAdmission({ channelId: "dm", userId: "owner-user" }), "owner");
  assert.equal(ownerDmPolicy.resolveAdmission({ channelId: "dm", userId: "other-user" }), "denied");
  assert.equal(ownerDmPolicy.canReceiveMessage({ channelId: "dm", userId: "other-user" }), false);
  assert.equal(ownerDmPolicy.canReceive({ channelId: "dm", userId: "other-user" }), false);
});

test("resolves linked and public admissions without changing their access", () => {
  assert.equal(
    linkedPolicy.resolveAdmission({
      guildId: "guild",
      channelId: "member-channel",
      userId: "member-user",
    }),
    "linked",
  );
  assert.equal(
    linkedPolicy.resolveAdmission({
      guildId: "guild",
      channelId: "member-channel",
      userId: "stranger",
    }),
    "public",
  );
  assert.equal(
    linkedPolicy.canReceiveMessage({ guildId: "guild", channelId: "member-channel" }),
    true,
  );
});

test("denies owner access on the message path when no owner is configured", () => {
  const unconfigured = createDiscordAccessPolicy({ default: "owner", directMessages: "owner" });

  assert.equal(
    unconfigured.resolveAdmission({ guildId: "guild", channelId: "channel", userId: "user-1" }),
    "denied",
  );
  assert.equal(
    unconfigured.canReceiveMessage({ guildId: "guild", channelId: "channel", userId: "user-1" }),
    false,
  );
});
