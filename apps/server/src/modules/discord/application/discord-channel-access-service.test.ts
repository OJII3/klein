import assert from "node:assert/strict";
import test from "node:test";

import type { DiscordAccess } from "../domain/discord-access-policy";
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

function createHarness(options: { failOwnerRequest?: boolean; failRuleUpdate?: boolean } = {}) {
  const persisted = new Map<string, PendingDiscordAccessRequest>();
  const posted: PendingDiscordAccessRequest[] = [];
  const ownerRequests: PendingDiscordAccessRequest[] = [];
  const notices: Array<{
    request: PendingDiscordAccessRequest;
    outcome: DiscordChannelAccessNoticeOutcome;
  }> = [];
  const updates: Array<{ target: DiscordAccessRuleTarget; access: DiscordAccess }> = [];

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
    ownerUserId: "owner-123",
  });

  return { notices, ownerRequests, persisted, posted, presentation, service, updates };
}

const request: DiscordChannelAccessRequest = {
  guildId: "guild-123",
  channelId: "parent-channel",
  threadId: "thread-123",
  pendingChannelId: "pending-channel",
  channelName: "thread-name",
  requesterUserId: "user-123",
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
