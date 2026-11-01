import assert from "node:assert/strict";
import test from "node:test";

import { migrateLegacyReminder } from "./legacy-reminder-migration";

const legacy = {
  id: "reminder-1",
  channelId: "channel-a",
  sessionKey: "discord-channel:channel-a",
  ownerFeaturesAllowed: false,
  message: "定例会",
  createdAt: "2026-10-14T00:00:00.000Z",
  dueAt: "2026-10-14T00:01:00.000Z",
};

test("migrates a one-time legacy reminder as public", () => {
  assert.deepEqual(migrateLegacyReminder(legacy), {
    kind: "reminder",
    id: "reminder-1",
    channelId: "channel-a",
    accessScope: "public",
    message: "定例会",
    createdAt: "2026-10-14T00:00:00.000Z",
    schedule: { type: "once", at: "2026-10-14T00:01:00.000Z" },
    nextRunAt: "2026-10-14T00:01:00.000Z",
  });
});

test("migrates owner-only, daily, and weekly reminders", () => {
  assert.equal(
    migrateLegacyReminder({ ...legacy, ownerFeaturesAllowed: true }, { ownerUserId: "123" })
      .accessScope,
    "owner:123",
  );
  assert.deepEqual(migrateLegacyReminder({ ...legacy, repeat: "daily", time: "09:00" }).schedule, {
    type: "daily",
    time: "09:00",
  });
  assert.deepEqual(
    migrateLegacyReminder({
      ...legacy,
      repeat: "weekly",
      time: "09:00",
      weekdays: ["mon", "thu"],
    }).schedule,
    { type: "weekly", time: "09:00", weekdays: ["mon", "thu"] },
  );
});

test("keeps an existing accessScope and rejects incomplete records", () => {
  assert.equal(
    migrateLegacyReminder({ ...legacy, accessScope: "owner:456" }).accessScope,
    "owner:456",
  );
  assert.throws(
    () => migrateLegacyReminder({ ...legacy, ownerFeaturesAllowed: true }),
    /owner\.discord\.userId/u,
  );
  assert.throws(() => migrateLegacyReminder({ ...legacy, dueAt: "invalid" }), /日時/u);
  assert.throws(
    () => migrateLegacyReminder({ ...legacy, repeat: "weekly", time: "09:00", weekdays: [] }),
    /曜日/u,
  );
});
