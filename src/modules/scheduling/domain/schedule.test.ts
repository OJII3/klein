import assert from "node:assert/strict";
import test from "node:test";

import {
  getNextRunAt,
  MAX_SCHEDULE_INTERVAL_MINUTES,
  parseStoredSchedule,
  resolveSchedule,
} from "./schedule";

test("resolves relative schedules to a single absolute run", () => {
  const now = Date.parse("2026-10-14T00:00:00.000Z");
  assert.deepEqual(resolveSchedule({ type: "after", minutes: 90 }, now), {
    schedule: { type: "once", at: "2026-10-14T01:30:00.000Z" },
    nextRunAt: "2026-10-14T01:30:00.000Z",
  });
  assert.throws(() => resolveSchedule({ type: "after", minutes: 0 }, now), /1分以上/u);
});

test("converts one-time JST date and time to an absolute timestamp", () => {
  const now = Date.parse("2026-10-13T00:00:00.000Z");
  assert.deepEqual(resolveSchedule({ type: "at", date: "2026-10-14", time: "09:30" }, now), {
    schedule: { type: "once", at: "2026-10-14T00:30:00.000Z" },
    nextRunAt: "2026-10-14T00:30:00.000Z",
  });
  assert.throws(
    () =>
      resolveSchedule(
        { type: "at", date: "2026-10-14", time: "09:30" },
        Date.parse("2026-10-14T00:30:00.000Z"),
      ),
    /未来/u,
  );
});

test("uses the next future occurrence when a one-time schedule has no date", () => {
  assert.equal(
    resolveSchedule({ type: "at", time: "09:30" }, Date.parse("2026-10-14T00:00:00.000Z"))
      .nextRunAt,
    "2026-10-14T00:30:00.000Z",
  );
  assert.equal(
    resolveSchedule({ type: "at", time: "09:30" }, Date.parse("2026-10-14T01:00:00.000Z"))
      .nextRunAt,
    "2026-10-15T00:30:00.000Z",
  );
});

test("schedules next daily, weekly, and interval occurrences", () => {
  const now = Date.parse("2026-10-14T00:00:00.000Z");
  assert.equal(
    resolveSchedule({ type: "daily", time: "08:00" }, now).nextRunAt,
    "2026-10-14T23:00:00.000Z",
  );
  assert.equal(
    resolveSchedule({ type: "weekly", time: "09:00", weekdays: ["thu"] }, now).nextRunAt,
    "2026-10-15T00:00:00.000Z",
  );
  assert.equal(
    resolveSchedule({ type: "every", minutes: 15 }, now).nextRunAt,
    "2026-10-14T00:15:00.000Z",
  );
});

test("skips missed daily occurrences and advances intervals from now", () => {
  assert.equal(
    getNextRunAt({ type: "daily", time: "08:00" }, Date.parse("2026-10-15T01:00:00.000Z")),
    "2026-10-15T23:00:00.000Z",
  );
  assert.equal(
    getNextRunAt({ type: "every", minutes: 10 }, Date.parse("2026-10-15T01:00:00.000Z")),
    "2026-10-15T01:10:00.000Z",
  );
  assert.equal(getNextRunAt({ type: "once", at: "2026-10-15T01:00:00.000Z" }, 0), undefined);
});

test("rejects intervals that would overflow a Date", () => {
  const now = Date.parse("2026-10-14T00:00:00.000Z");
  assert.throws(
    () => resolveSchedule({ type: "every", minutes: MAX_SCHEDULE_INTERVAL_MINUTES + 1 }, now),
    /1年以内/u,
  );
  assert.throws(
    () => resolveSchedule({ type: "after", minutes: MAX_SCHEDULE_INTERVAL_MINUTES + 1 }, now),
    /1年以内/u,
  );
  assert.throws(
    () => parseStoredSchedule({ type: "every", minutes: MAX_SCHEDULE_INTERVAL_MINUTES + 1 }),
    /1年以内/u,
  );
});

test("parses only the new stored schedule shape", () => {
  assert.deepEqual(parseStoredSchedule({ type: "every", minutes: 5 }), {
    type: "every",
    minutes: 5,
  });
  assert.deepEqual(parseStoredSchedule({ type: "once", at: "2026-10-14T00:00:00.000Z" }), {
    type: "once",
    at: "2026-10-14T00:00:00.000Z",
  });
  assert.throws(() => parseStoredSchedule({ type: "after", minutes: 5 }), /種類/u);
  assert.throws(() => parseStoredSchedule({ type: "daily", time: "25:00" }), /時刻/u);
  assert.throws(
    () => parseStoredSchedule({ type: "weekly", time: "09:00", weekdays: [] }),
    /曜日/u,
  );
});
