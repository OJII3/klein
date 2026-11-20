import assert from "node:assert/strict";
import test from "node:test";

import type { DiscordAccess } from "../domain/discord-access-policy";
import { discordChannelLinkLocationKey } from "../domain/discord-channel-link";
import {
  createDiscordChannelAccessButtonId,
  type DiscordChannelAccessNoticeOutcome,
  type DiscordChannelAccessRequest,
  type PendingDiscordAccessRequest,
} from "../domain/discord-access-request";
import type { DiscordAccessRuleTarget } from "../ports/discord-access-rule-store";
import {
  DiscordChannelAccessService,
  type DiscordChannelAccessPresentation,
} from "./discord-channel-access-service";

function createHarness(
  options: {
    failOwnerRequest?: boolean;
    failRuleUpdate?: boolean;
    failLinkUpdate?: boolean;
    failLinkRemove?: boolean;
    existingLinkUserId?: string;
  } = {},
) {
  const persisted = new Map<string, PendingDiscordAccessRequest>();
  const posted: PendingDiscordAccessRequest[] = [];
  const ownerRequests: PendingDiscordAccessRequest[] = [];
  const notices: Array<{
    request: PendingDiscordAccessRequest;
    outcome: DiscordChannelAccessNoticeOutcome;
  }> = [];
  const updates: Array<{ target: DiscordAccessRuleTarget; access: DiscordAccess }> = [];
  const links = new Map<string, { userId: string; linkedAt: string }>();

  if (options.existingLinkUserId) {
    links.set(
      discordChannelLinkLocationKey({
        guildId: "guild-123",
        channelId: "parent-channel",
        threadId: "thread-123",
      }),
      {
        userId: options.existingLinkUserId,
        linkedAt: "2026-01-01T00:00:00.000Z",
      },
    );
  }
  const channelLinkStore = {
    getLink: (target: { guildId: string; channelId: string; threadId?: string }) => {
      const link = links.get(discordChannelLinkLocationKey(target));
      return link
        ? {
            ...target,
            ...link,
          }
        : undefined;
    },
    saveLink: async (link: {
      guildId: string;
      channelId: string;
      threadId?: string;
      userId: string;
      linkedAt: string;
    }) => {
      if (options.failLinkUpdate) throw new Error("store unavailable");
      links.set(discordChannelLinkLocationKey(link), {
        userId: link.userId,
        linkedAt: link.linkedAt,
      });
    },
    removeLink: async (target: { guildId: string; channelId: string; threadId?: string }) => {
      if (options.failLinkRemove) throw new Error("store unavailable");
      links.delete(discordChannelLinkLocationKey(target));
    },
  };

  const presentation: DiscordChannelAccessPresentation = {
    postPendingNotice: async (request) => {
      posted.push(request);
      return { messageId: "pending-message-1" };
    },
    sendOwnerRequest: async (request) => {
      if (options.failOwnerRequest) throw new Error("owner unavailable");
      ownerRequests.push(request);
    },
    updatePendingNotice: async (request, outcome) => {
      notices.push({ request, outcome });
    },
  };

  const service = new DiscordChannelAccessService({
    accessRuleStore: {
      setAccess: async (target, access) => {
        if (options.failRuleUpdate) throw new Error("store unavailable");
        updates.push({ target, access });
      },
    },
    accessRequestStore: {
      list: () => [...persisted.values()],
      save: async (request) => {
        persisted.set(request.requestId, request);
      },
      remove: async (requestId) => {
        persisted.delete(requestId);
      },
    },
    channelLinkStore,
    ownerUserId: "owner-123",
  });

  return {
    links,
    notices,
    ownerRequests,
    persisted,
    posted,
    presentation,
    service,
    updates,
  };
}

const request: DiscordChannelAccessRequest = {
  guildId: "guild-123",
  channelId: "parent-channel",
  threadId: "thread-123",
  pendingChannelId: "pending-channel",
  channelName: "thread-name",
  requesterUserId: "user-123",
};

const linkRequest: DiscordChannelAccessRequest = {
  ...request,
  linkUserId: "user-123",
};

test("posts a pending notice, asks the owner and persists the request", async () => {
  const harness = createHarness();

  await harness.service.request(request, harness.presentation);

  assert.equal(harness.posted.length, 1);
  assert.equal(harness.posted[0]?.pendingMessageId, undefined);
  assert.equal(harness.ownerRequests[0]?.requestId, harness.posted[0]?.requestId);
  assert.equal(harness.persisted.size, 1);
  const [saved] = [...harness.persisted.values()];
  assert.equal(saved?.pendingMessageId, "pending-message-1");
});

test("does not ask twice for the same channel while a request is pending", async () => {
  const harness = createHarness();

  await harness.service.request(request, harness.presentation);
  await harness.service.request(request, harness.presentation);

  assert.equal(harness.posted.length, 1);
  assert.equal(harness.ownerRequests.length, 1);
  assert.equal(harness.persisted.size, 1);
});

test("lets only the owner decide and applies the access rule", async () => {
  const harness = createHarness();
  await harness.service.request(request, harness.presentation);
  const pending = harness.ownerRequests[0];
  assert.ok(pending);

  const rejected = await harness.service.handleButton({
    customId: createDiscordChannelAccessButtonId("allow", pending.requestId),
    userId: "other-user",
  });
  assert.deepEqual(rejected, { kind: "rejected", reason: "owner-only" });

  const decided = await harness.service.handleButton({
    customId: createDiscordChannelAccessButtonId("allow", pending.requestId),
    userId: "owner-123",
  });
  assert.equal(decided.kind, "decided");
  if (decided.kind !== "decided") return;
  assert.equal(decided.access, "allow");
  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "allow",
    },
  ]);
  assert.equal(harness.persisted.size, 0);
});

test("keeps the request when the access rule cannot be updated", async () => {
  const harness = createHarness({ failRuleUpdate: true });
  await harness.service.request(request, harness.presentation);
  const pending = harness.ownerRequests[0];
  assert.ok(pending);

  const result = await harness.service.handleButton({
    customId: createDiscordChannelAccessButtonId("deny", pending.requestId),
    userId: "owner-123",
  });

  assert.deepEqual(result, { kind: "rejected", reason: "rule-update-failed" });
  assert.equal(harness.persisted.size, 1);
});

test("removes the request when the owner cannot be reached", async () => {
  const harness = createHarness({ failOwnerRequest: true });

  await harness.service.request(request, harness.presentation);

  assert.equal(harness.persisted.size, 0);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0]?.outcome, "owner-unreachable");
  assert.equal(harness.notices[0]?.request.pendingMessageId, "pending-message-1");
});

test("registers the requester as the owner when a link request is approved", async () => {
  const harness = createHarness();
  await harness.service.request(linkRequest, harness.presentation);
  const pending = harness.ownerRequests[0];
  assert.ok(pending);

  const decided = await harness.service.handleButton({
    customId: createDiscordChannelAccessButtonId("allow", pending.requestId),
    userId: "owner-123",
  });

  assert.equal(decided.kind, "decided");
  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "allow",
    },
  ]);
  assert.equal(harness.links.get("guild-123:parent-channel:thread-123")?.userId, "user-123");
  assert.equal(harness.persisted.size, 0);
});

test("leaves the access rule unchanged when a link request is denied", async () => {
  const harness = createHarness();
  await harness.service.request(linkRequest, harness.presentation);
  const pending = harness.ownerRequests[0];
  assert.ok(pending);

  const decided = await harness.service.handleButton({
    customId: createDiscordChannelAccessButtonId("deny", pending.requestId),
    userId: "owner-123",
  });

  assert.equal(decided.kind, "decided");
  assert.deepEqual(harness.updates, []);
  assert.equal(harness.links.size, 0);
  assert.equal(harness.persisted.size, 0);
});

test("returns already-linked without asking the owner again", async () => {
  const harness = createHarness({ existingLinkUserId: "user-123" });

  const outcome = await harness.service.request(linkRequest, harness.presentation);

  assert.deepEqual(outcome, { kind: "already-linked", userId: "user-123" });
  assert.equal(harness.posted.length, 0);
  assert.equal(harness.ownerRequests.length, 0);
});

test("does not ask the owner when the channel is already linked to another user", async () => {
  const harness = createHarness({ existingLinkUserId: "other-user" });

  const outcome = await harness.service.request(linkRequest, harness.presentation);

  assert.deepEqual(outcome, { kind: "already-linked", userId: "other-user" });
  assert.equal(harness.posted.length, 0);
  assert.equal(harness.ownerRequests.length, 0);
  assert.equal(harness.links.get("guild-123:parent-channel:thread-123")?.userId, "other-user");
});

test("keeps the request when the channel link cannot be saved", async () => {
  const harness = createHarness({ failLinkUpdate: true });
  await harness.service.request(linkRequest, harness.presentation);
  const pending = harness.ownerRequests[0];
  assert.ok(pending);

  const result = await harness.service.handleButton({
    customId: createDiscordChannelAccessButtonId("allow", pending.requestId),
    userId: "owner-123",
  });

  assert.deepEqual(result, { kind: "rejected", reason: "link-update-failed" });
  assert.equal(harness.persisted.size, 1);
});

test("unlinks a channel and denies access", async () => {
  const harness = createHarness({ existingLinkUserId: "user-123" });

  const result = await harness.service.unlink(
    { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
    harness.presentation,
  );

  assert.equal(result.kind, "unlinked");
  assert.equal(harness.links.get("guild-123:parent-channel:thread-123"), undefined);
  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "deny",
    },
  ]);
});

test("cancels a pending link request when the location is not linked", async () => {
  const harness = createHarness();
  await harness.service.request(linkRequest, harness.presentation);
  assert.equal(harness.persisted.size, 1);

  const result = await harness.service.unlink(
    { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
    harness.presentation,
  );

  assert.deepEqual(result, { kind: "not-linked" });
  assert.equal(harness.persisted.size, 0);
  assert.equal(harness.notices.at(-1)?.outcome, "denied");
});

test("reports not-linked without changing access", async () => {
  const harness = createHarness();

  const result = await harness.service.unlink(
    { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
    harness.presentation,
  );

  assert.deepEqual(result, { kind: "not-linked" });
  assert.deepEqual(harness.updates, []);
});

test("keeps the link when access cannot be denied during unlink", async () => {
  const harness = createHarness({ existingLinkUserId: "user-123", failRuleUpdate: true });

  const result = await harness.service.unlink(
    { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
    harness.presentation,
  );

  assert.deepEqual(result, { kind: "failed" });
  assert.equal(harness.links.get("guild-123:parent-channel:thread-123")?.userId, "user-123");
});

test("reports failure when the link cannot be removed", async () => {
  const harness = createHarness({ existingLinkUserId: "user-123", failLinkRemove: true });

  const result = await harness.service.unlink(
    { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
    harness.presentation,
  );

  assert.deepEqual(result, { kind: "failed" });
  assert.equal(harness.links.get("guild-123:parent-channel:thread-123")?.userId, "user-123");
});
