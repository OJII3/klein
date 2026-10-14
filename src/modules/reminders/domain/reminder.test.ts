import assert from "node:assert/strict";
import test from "node:test";

import { getNextReminderDueAt, getReminderDueAt } from "./reminder";

test("schedules relative reminders in whole minutes", () => {
  assert.equal(
    getReminderDueAt({ type: "after", minutes: 90 }, Date.parse("2026-10-14T00:00:00.000Z")),
    "2026-10-14T01:30:00.000Z",
  );
  assert.throws(() => getReminderDueAt({ type: "after", minutes: 0 }, Date.now()), /1分以上/u);
});

test("converts one-time JST date and time to an absolute timestamp", () => {
  assert.equal(
    getReminderDueAt(
      { type: "at", date: "2026-10-14", time: "09:30" },
      Date.parse("2026-10-13T00:00:00.000Z"),
    ),
    "2026-10-14T00:30:00.000Z",
  );
  assert.throws(
    () =>
      getReminderDueAt(
        { type: "at", date: "2026-10-14", time: "09:30" },
        Date.parse("2026-10-14T00:30:00.000Z"),
      ),
    /未来/u,
  );
});

test("uses the next future occurrence when a one-time reminder has no date", () => {
  assert.equal(
    getReminderDueAt({ type: "at", time: "09:30" }, Date.parse("2026-10-14T00:00:00.000Z")),
    "2026-10-14T00:30:00.000Z",
  );
  assert.equal(
    getReminderDueAt({ type: "at", time: "09:30" }, Date.parse("2026-10-14T01:00:00.000Z")),
    "2026-10-15T00:30:00.000Z",
  );
});

test("schedules recurring reminders at the next daily or selected weekly JST time", () => {
  const now = Date.parse("2026-10-14T00:00:00.000Z");
  assert.equal(getReminderDueAt({ type: "daily", time: "08:00" }, now), "2026-10-14T23:00:00.000Z");
  assert.equal(
    getReminderDueAt({ type: "weekly", time: "09:00", weekdays: ["thu"] }, now),
    "2026-10-15T00:00:00.000Z",
  );
});

test("skips missed recurring occurrences and returns the next future time", () => {
  const next = getNextReminderDueAt(
    {
      id: "daily",
      sessionKey: "session",
      channelId: "channel",
      ownerFeaturesAllowed: false,
      message: "message",
      createdAt: "2026-10-13T00:00:00.000Z",
      dueAt: "2026-10-13T23:00:00.000Z",
      repeat: "daily",
      time: "08:00",
    },
    Date.parse("2026-10-15T01:00:00.000Z"),
  );

  assert.equal(next, "2026-10-15T23:00:00.000Z");
});
