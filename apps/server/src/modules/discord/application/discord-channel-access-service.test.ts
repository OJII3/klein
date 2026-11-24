import assert from "node:assert/strict";
import test from "node:test";

import type { DiscordAccess } from "../domain/discord-access-policy";
import {
  createDiscordChannelAccessButtonId,
  type DiscordChannelAccessNoticeOutcome,
  type DiscordChannelAccessRequest,
  type PendingDiscordAccessRequest,
} from "../domain/discord-access-request";
import { DISCORD_APPROVAL_REQUEST_TTL_MS } from "../domain/discord-approval-request";
import type { DiscordAccessRuleTarget } from "../ports/discord-access-rule-store";
import { DiscordChannelAccessService } from "./discord-channel-access-service";
import type { DiscordApprovalPresentation } from "./discord-approval-service";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

function createHarness(
  options: {
    failOwnerRequest?: boolean;
    failRuleUpdate?: boolean;
    failSave?: boolean;
    now?: number;
    seedRequests?: readonly PendingDiscordAccessRequest[];
  } = {},
) {
  const calls: string[] = [];
  const savedVersions: PendingDiscordAccessRequest[] = [];
  const persisted = new Map<string, PendingDiscordAccessRequest>(
    (options.seedRequests ?? []).map((stored) => [stored.requestId, stored]),
  );
  const posted: PendingDiscordAccessRequest[] = [];
  const ownerRequests: PendingDiscordAccessRequest[] = [];
  const notices: Array<{
    request: PendingDiscordAccessRequest;
    outcome: DiscordChannelAccessNoticeOutcome;
  }> = [];
  const updates: Array<{ target: DiscordAccessRuleTarget; access: DiscordAccess }> = [];
  const controls = { failSave: options.failSave ?? false };
  let now = options.now ?? NOW;
  const clock = {
    advance(ms: number) {
      now += ms;
    },
  };

  const presentation: DiscordApprovalPresentation<PendingDiscordAccessRequest> = {
    postPendingNotice: async (request) => {
      calls.push("post-pending-notice");
      posted.push(request);
      return { messageId: "pending-message-1" };
    },
    sendOwnerRequest: async (request) => {
      calls.push("send-owner-request");
      if (options.failOwnerRequest) throw new Error("owner unavailable");
      ownerRequests.push(request);
      return { messageId: "owner-message-1" };
    },
    updatePendingNotice: async (request, outcome) => {
      calls.push("update-pending-notice");
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
        calls.push("save");
        if (controls.failSave) throw new Error("store unavailable");
        savedVersions.push(request);
        persisted.set(request.requestId, request);
      },
      remove: async (requestId) => {
        calls.push("remove");
        persisted.delete(requestId);
      },
    },
    ownerUserId: "owner-123",
    now: () => now,
  });

  return {
    calls,
    clock,
    controls,
    notices,
    ownerRequests,
    persisted,
    posted,
    presentation,
    savedVersions,
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

const storedRequest: PendingDiscordAccessRequest = {
  ...request,
  requestId: "stored-request",
};

test("asks the owner about the posted notice and keeps its message id", async () => {
  const harness = createHarness();

  await harness.service.request(request, harness.presentation);

  assert.equal(harness.posted.length, 1);
  assert.equal(harness.posted[0]?.pendingMessageId, undefined);
  assert.equal(harness.ownerRequests[0]?.requestId, harness.posted[0]?.requestId);
  assert.equal(harness.persisted.size, 1);
  const [saved] = [...harness.persisted.values()];
  assert.equal(saved?.pendingMessageId, "pending-message-1");
  assert.equal(saved?.ownerMessageId, "owner-message-1");
});

test("persists the request with an expiry before showing it to anyone", async () => {
  const harness = createHarness();

  await harness.service.request(request, harness.presentation);

  const firstSave = harness.calls.indexOf("save");
  assert.ok(firstSave >= 0);
  assert.ok(firstSave < harness.calls.indexOf("post-pending-notice"));
  assert.ok(firstSave < harness.calls.indexOf("send-owner-request"));
  const expiresAt = new Date(NOW + DISCORD_APPROVAL_REQUEST_TTL_MS).toISOString();
  assert.equal(harness.savedVersions[0]?.expiresAt, expiresAt);
  assert.equal(harness.savedVersions[0]?.pendingMessageId, undefined);
  assert.equal(harness.ownerRequests[0]?.expiresAt, expiresAt);
});

test("shows nothing and blocks nothing when the initial save fails", async () => {
  const harness = createHarness({ failSave: true });

  assert.equal(await harness.service.request(request, harness.presentation), "unavailable");

  assert.equal(harness.posted.length, 0);
  assert.equal(harness.ownerRequests.length, 0);
  assert.equal(harness.savedVersions.length, 0);
  assert.equal(harness.persisted.size, 0);

  harness.controls.failSave = false;
  assert.equal(await harness.service.request(request, harness.presentation), "requested");
  assert.equal(harness.posted.length, 1);
  assert.equal(harness.ownerRequests.length, 1);
  assert.equal(harness.persisted.size, 1);
});

test("replaces an expired request at the same location", async () => {
  const harness = createHarness();
  assert.equal(await harness.service.request(request, harness.presentation), "requested");
  const first = harness.ownerRequests[0];
  assert.ok(first);

  harness.clock.advance(DISCORD_APPROVAL_REQUEST_TTL_MS + 1);
  assert.equal(await harness.service.request(request, harness.presentation), "requested");

  assert.equal(harness.posted.length, 2);
  assert.equal(harness.persisted.size, 1);
  const [saved] = [...harness.persisted.values()];
  assert.notEqual(saved?.requestId, first.requestId);
  assert.equal(
    saved?.expiresAt,
    new Date(NOW + DISCORD_APPROVAL_REQUEST_TTL_MS * 2 + 1).toISOString(),
  );
});

test("rejects an expired button without applying access", async () => {
  const harness = createHarness();
  await harness.service.request(request, harness.presentation);
  const pending = harness.ownerRequests[0];
  assert.ok(pending);

  harness.clock.advance(DISCORD_APPROVAL_REQUEST_TTL_MS + 1);
  const result = await harness.service.handleButton({
    customId: createDiscordChannelAccessButtonId("allow", pending.requestId),
    userId: "owner-123",
  });

  assert.deepEqual(result, { kind: "rejected", reason: "expired" });
  assert.deepEqual(harness.updates, []);
  assert.equal(harness.persisted.size, 0);
});

test("treats a stored request without an expiry as expired", async () => {
  const harness = createHarness({ seedRequests: [storedRequest] });

  const result = await harness.service.handleButton({
    customId: createDiscordChannelAccessButtonId("allow", storedRequest.requestId),
    userId: "owner-123",
  });

  assert.deepEqual(result, { kind: "rejected", reason: "expired" });
  assert.deepEqual(harness.updates, []);
  assert.equal(harness.persisted.size, 0);
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
  assert.equal(decided.allowed, true);
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

  assert.deepEqual(result, { kind: "rejected", reason: "update-failed" });
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

const FUTURE_EXPIRY = new Date(NOW + DISCORD_APPROVAL_REQUEST_TTL_MS).toISOString();

test("removes an expired request at startup and tells the requester it expired", async () => {
  const harness = createHarness({
    seedRequests: [{ ...storedRequest, expiresAt: new Date(NOW - 1).toISOString() }],
  });

  await harness.service.reconcile(harness.presentation);

  assert.equal(harness.persisted.size, 0);
  assert.equal(harness.ownerRequests.length, 0);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0]?.outcome, "expired");
});

test("removes a stored request without an expiry at startup", async () => {
  const harness = createHarness({ seedRequests: [storedRequest] });

  await harness.service.reconcile(harness.presentation);

  assert.equal(harness.persisted.size, 0);
  assert.equal(harness.notices[0]?.outcome, "expired");
});

test("resends the owner request at startup when its message id is missing", async () => {
  const harness = createHarness({
    seedRequests: [{ ...storedRequest, expiresAt: FUTURE_EXPIRY }],
  });

  await harness.service.reconcile(harness.presentation);
  await harness.service.reconcile(harness.presentation);

  assert.equal(harness.ownerRequests.length, 1);
  assert.equal(harness.ownerRequests[0]?.requestId, storedRequest.requestId);
  assert.equal(harness.persisted.get(storedRequest.requestId)?.ownerMessageId, "owner-message-1");
});

test("does not resend the owner request when its message id is stored", async () => {
  const harness = createHarness({
    seedRequests: [
      { ...storedRequest, expiresAt: FUTURE_EXPIRY, ownerMessageId: "owner-message-0" },
    ],
  });

  await harness.service.reconcile(harness.presentation);

  assert.equal(harness.ownerRequests.length, 0);
  assert.equal(harness.persisted.get(storedRequest.requestId)?.ownerMessageId, "owner-message-0");
});

test("removes the request at startup when the owner cannot be reached again", async () => {
  const harness = createHarness({
    failOwnerRequest: true,
    seedRequests: [{ ...storedRequest, expiresAt: FUTURE_EXPIRY }],
  });

  await harness.service.reconcile(harness.presentation);

  assert.equal(harness.ownerRequests.length, 0);
  assert.equal(harness.persisted.size, 0);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0]?.outcome, "owner-unreachable");
});
