import assert from "node:assert/strict";
import test from "node:test";

import {
  DiscordChannelRuleCommand,
  type DiscordChannelRuleCommandTarget,
} from "./discord-channel-rule-command";

const target: DiscordChannelRuleCommandTarget = {
  inGuild: true,
  canUseApplicationCommands: true,
  guildId: "guild-123",
  channelId: "channel-123",
};

function createStore(initial?: string) {
  const writes: Array<{ guildId: string; channelId: string; rule: string }> = [];
  return {
    writes,
    store: {
      async get() {
        return initial;
      },
      async set(guildId: string, channelId: string, rule: string) {
        writes.push({ guildId, channelId, rule });
      },
    },
  };
}

test("returns the stored rule so the editor can prefill it", async () => {
  const storage = createStore("既存のルール");
  const command = new DiscordChannelRuleCommand(storage.store);

  assert.deepEqual(await command.getRuleForEdit(target), {
    kind: "editable",
    rule: "既存のルール",
  });
});

test("returns an empty editor when the channel has no rule", async () => {
  const command = new DiscordChannelRuleCommand(createStore().store);

  assert.deepEqual(await command.getRuleForEdit(target), { kind: "editable" });
});

test("saves the submitted text under the target channel", async () => {
  const storage = createStore();
  const command = new DiscordChannelRuleCommand(storage.store);

  assert.deepEqual(await command.applyRuleEdit(target, "  新しいルール  "), { kind: "saved" });
  assert.deepEqual(storage.writes, [
    { guildId: "guild-123", channelId: "channel-123", rule: "  新しいルール  " },
  ]);
});

test("reports a blank submission as a deletion", async () => {
  const storage = createStore("既存のルール");
  const command = new DiscordChannelRuleCommand(storage.store);

  assert.deepEqual(await command.applyRuleEdit(target, "   "), { kind: "deleted" });
  assert.deepEqual(storage.writes, [
    { guildId: "guild-123", channelId: "channel-123", rule: "   " },
  ]);
});

test("rejects edits outside a guild before touching the store", async () => {
  const storage = createStore();
  const command = new DiscordChannelRuleCommand(storage.store);

  assert.deepEqual(await command.applyRuleEdit({ ...target, inGuild: false }, "rule"), {
    kind: "rejected",
    reason: "guild-only",
  });
  assert.deepEqual(storage.writes, []);
});

test("rejects edits without the application command permission", async () => {
  const storage = createStore();
  const command = new DiscordChannelRuleCommand(storage.store);

  assert.deepEqual(
    await command.applyRuleEdit({ ...target, canUseApplicationCommands: false }, "rule"),
    { kind: "rejected", reason: "missing-permission" },
  );
  assert.deepEqual(storage.writes, []);
});

test("rejects edits when the guild or channel is missing", async () => {
  const storage = createStore();
  const command = new DiscordChannelRuleCommand(storage.store);

  assert.deepEqual(await command.getRuleForEdit({ ...target, channelId: undefined }), {
    kind: "rejected",
    reason: "unknown-channel",
  });
  assert.deepEqual(await command.applyRuleEdit({ ...target, guildId: undefined }, "rule"), {
    kind: "rejected",
    reason: "unknown-channel",
  });
  assert.deepEqual(storage.writes, []);
});
