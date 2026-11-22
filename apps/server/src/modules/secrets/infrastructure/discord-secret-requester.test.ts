import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import test from "node:test";

import type { SecretControl, SecretSubmissionOutcome } from "../application/secret-service";
import type { SecretSummary, SecretValues } from "../domain/secret";
import type { SecretRequest, SecretRequestDraft } from "../domain/secret-request";
import {
  DiscordSecretRequester,
  type DiscordSecretButtonInteraction,
  type DiscordSecretModalSubmitInteraction,
} from "./discord-secret-requester";

const request: SecretRequest = {
  requestId: "request-1",
  userId: "123",
  channelId: "channel-1",
  accessScope: "user:123",
  workerId: "worker-1",
  service: "github",
  label: "GitHub",
  reason: "Issueを確認するため",
  fields: [{ key: "token", label: "トークン", env: "GH_TOKEN" }],
  createdAt: "2026-11-22T00:00:00.000Z",
  expiresAt: "2026-11-22T00:15:00.000Z",
  dmChannelId: "dm-channel",
  dmMessageId: "dm-message",
};

const draft: SecretRequestDraft = {
  userId: "123",
  channelId: "channel-1",
  accessScope: "user:123",
  workerId: "worker-1",
  service: "github",
  label: "GitHub",
  reason: "Issueを確認するため",
  fields: [{ key: "token", label: "トークン", env: "GH_TOKEN" }],
};

const secret: SecretSummary = {
  service: "github",
  label: "GitHub",
  fields: [{ key: "token", label: "トークン", env: "GH_TOKEN" }],
  updatedAt: "2026-11-22T00:00:00.000Z",
};

function createHarness(options: { dmFails?: boolean; completed?: SecretSubmissionOutcome } = {}) {
  const sent: { userId: string; payload: unknown }[] = [];
  const edits: unknown[] = [];
  const attached: { requestId: string; dmChannelId: string; dmMessageId: string }[] = [];
  const abandoned: string[] = [];
  const completed: { requestId: string; userId: string; values: Record<string, string> }[] = [];
  const cancelled: string[] = [];

  const service: SecretControl = {
    async request(_draft) {
      return { kind: "requested", request };
    },
    async lookupPending() {
      return { kind: "pending", request };
    },
    async attachMessage(requestId, dmChannelId, dmMessageId) {
      attached.push({ requestId, dmChannelId, dmMessageId });
    },
    async abandon(requestId) {
      abandoned.push(requestId);
    },
    async complete(requestId, userId, values) {
      completed.push({ requestId, userId, values: { ...values } });
      return options.completed ?? { kind: "saved", secret };
    },
    async cancel(requestId) {
      cancelled.push(requestId);
      return { kind: "cancelled" };
    },
    async list(): Promise<readonly SecretSummary[]> {
      return [];
    },
    async read(): Promise<SecretValues | undefined> {
      return undefined;
    },
    async delete() {
      return false;
    },
  };

  const client = {
    users: {
      async fetch(id: string) {
        return {
          async send(payload: unknown) {
            if (options.dmFails) throw new Error("Cannot send messages to this user");
            sent.push({ userId: id, payload });
            return { id: "dm-message", channelId: "dm-channel" };
          },
        };
      },
    },
    channels: {
      async fetch() {
        return {
          messages: {
            async fetch() {
              return {
                async edit(payload: unknown) {
                  edits.push(payload);
                },
              };
            },
          },
        };
      },
    },
  };

  return {
    requester: new DiscordSecretRequester({ client, service }),
    sent,
    edits,
    attached,
    abandoned,
    completed,
    cancelled,
  };
}

function createButtonInteraction(
  customId: string,
  userId = "123",
): {
  interaction: DiscordSecretButtonInteraction;
  modals: { toJSON(): unknown }[];
  replies: { content: string; flags: MessageFlags.Ephemeral }[];
  updates: unknown[];
} {
  const modals: { toJSON(): unknown }[] = [];
  const replies: { content: string; flags: MessageFlags.Ephemeral }[] = [];
  const updates: unknown[] = [];
  return {
    interaction: {
      customId,
      user: { id: userId },
      async reply(reply) {
        replies.push(reply);
        return undefined;
      },
      async update(payload) {
        updates.push(payload);
        return undefined;
      },
      async showModal(modal) {
        modals.push(modal);
        return undefined;
      },
    },
    modals,
    replies,
    updates,
  };
}

test("sends a Components v2 direct message and remembers it", async () => {
  const harness = createHarness();
  const outcome = await harness.requester.request(draft);

  assert.equal(outcome.kind, "requested");
  assert.equal(harness.sent.length, 1);
  const payload = harness.sent[0]?.payload;
  const serialized = JSON.stringify(payload);
  assert.match(serialized, new RegExp(`"flags":${MessageFlags.IsComponentsV2}`, "u"));
  assert.match(serialized, /シークレットの入力/u);
  assert.match(serialized, /GH_TOKEN/u);
  assert.match(serialized, /klein-secret:input:request-1/u);
  assert.match(serialized, /klein-secret:cancel:request-1/u);
  assert.deepEqual(harness.attached, [
    { requestId: "request-1", dmChannelId: "dm-channel", dmMessageId: "dm-message" },
  ]);
});

test("reports direct-message failures and removes the pending request", async () => {
  const harness = createHarness({ dmFails: true });

  assert.equal((await harness.requester.request(draft)).kind, "unavailable");
  assert.deepEqual(harness.abandoned, ["request-1"]);
});

test("opens a modal with one input per requested field", async () => {
  const harness = createHarness();
  const button = createButtonInteraction("klein-secret:input:request-1");

  assert.equal(await harness.requester.handleButton(button.interaction), true);
  assert.equal(button.modals.length, 1);
  const serialized = JSON.stringify(button.modals[0]);
  assert.match(serialized, /"custom_id":"klein-secret-modal:request-1"/u);
  assert.match(serialized, /"custom_id":"klein-secret-field:request-1:token"/u);
});

test("refuses a button press from another user", async () => {
  const harness = createHarness();
  const button = createButtonInteraction("klein-secret:input:request-1", "456");

  assert.equal(await harness.requester.handleButton(button.interaction), true);
  assert.equal(button.modals.length, 0);
  assert.match(button.replies[0]?.content ?? "", /本人だけ/u);
});

test("saves modal values and updates the direct message", async () => {
  const harness = createHarness();
  const replies: unknown[] = [];
  const interaction: DiscordSecretModalSubmitInteraction = {
    customId: "klein-secret-modal:request-1",
    user: { id: "123" },
    fields: {
      getTextInputValue(customId) {
        assert.equal(customId, "klein-secret-field:request-1:token");
        return "secret-token";
      },
    },
    async reply(payload) {
      replies.push(payload);
      return undefined;
    },
  };

  assert.equal(await harness.requester.handleModalSubmit(interaction), true);
  assert.deepEqual(harness.completed, [
    { requestId: "request-1", userId: "123", values: { token: "secret-token" } },
  ]);
  assert.match(JSON.stringify(replies[0]), /保存しました/u);
  assert.equal(harness.edits.length, 1);
  assert.match(JSON.stringify(harness.edits[0]), /保存しました/u);
});

test("cancels a request from its button", async () => {
  const harness = createHarness();
  const button = createButtonInteraction("klein-secret:cancel:request-1");

  assert.equal(await harness.requester.handleButton(button.interaction), true);
  assert.deepEqual(harness.cancelled, ["request-1"]);
  assert.match(JSON.stringify(button.updates[0]), /キャンセルしました/u);
});

test("ignores unrelated buttons and modals", async () => {
  const harness = createHarness();
  const button = createButtonInteraction("other:input:request-1");

  assert.equal(await harness.requester.handleButton(button.interaction), false);
  assert.equal(
    await harness.requester.handleModalSubmit({
      customId: "other-modal:request-1",
      user: { id: "123" },
      fields: { getTextInputValue: () => "" },
      async reply() {
        return undefined;
      },
    }),
    false,
  );
});
