import assert from "node:assert/strict";
import test from "node:test";

import { decideDiscordOperatingModeCommand } from "./discord-operating-mode-command";

test("maps the status subcommands to an operating mode", () => {
  assert.deepEqual(
    decideDiscordOperatingModeCommand({
      subcommand: "idle",
      inGuild: true,
      canManageGuild: true,
    }),
    { kind: "changed", mode: "paused" },
  );
  assert.deepEqual(
    decideDiscordOperatingModeCommand({
      subcommand: "online",
      inGuild: true,
      canManageGuild: true,
    }),
    { kind: "changed", mode: "active" },
  );
});

test("ignores unknown status subcommands before checking the guild", () => {
  assert.deepEqual(
    decideDiscordOperatingModeCommand({
      subcommand: "unknown",
      inGuild: false,
      canManageGuild: false,
    }),
    { kind: "ignored" },
  );
});

test("rejects status changes outside a guild", () => {
  assert.deepEqual(
    decideDiscordOperatingModeCommand({
      subcommand: "idle",
      inGuild: false,
      canManageGuild: true,
    }),
    { kind: "rejected", reason: "guild-only" },
  );
});

test("rejects status changes without the manage permission", () => {
  assert.deepEqual(
    decideDiscordOperatingModeCommand({
      subcommand: "idle",
      inGuild: true,
      canManageGuild: false,
    }),
    { kind: "rejected", reason: "missing-permission" },
  );
});
