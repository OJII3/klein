import assert from "node:assert/strict";

import { test } from "bun:test";

import {
  isAtOrAfterJapanTime,
  isWithinQuietHours,
  japanDateKey,
  japanTimestampForToday,
  parseJapanTime,
} from "./japan-time";

const MINUTE = 60_000;
const JST_OFFSET = 9 * 60 * MINUTE;

function japanTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET;
}

test("parses Japan times and rejects invalid values", () => {
  assert.deepEqual(parseJapanTime("09:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseJapanTime("00:00"), { hour: 0, minute: 0 });
  assert.deepEqual(parseJapanTime("23:59"), { hour: 23, minute: 59 });
  assert.throws(() => parseJapanTime("9:05"), /HH:mm/u);
  assert.throws(() => parseJapanTime("24:00"), /有効/u);
  assert.throws(() => parseJapanTime("09:60"), /有効/u);
});

test("handles quiet hours inside one day at both boundaries", () => {
  const quietHours = { start: "09:00", end: "17:00" };
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 20, 8, 59)), false);
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 20, 9, 0)), true);
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 20, 12, 0)), true);
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 20, 16, 59)), true);
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 20, 17, 0)), false);
});

test("handles quiet hours that cross midnight", () => {
  const quietHours = { start: "23:00", end: "08:00" };
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 20, 22, 59)), false);
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 20, 23, 0)), true);
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 21, 0, 0)), true);
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 21, 7, 59)), true);
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 21, 8, 0)), false);
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 21, 12, 0)), false);
});

test("treats equal quiet hour bounds as empty instead of all day", () => {
  const quietHours = { start: "23:00", end: "23:00" };
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 20, 23, 0)), false);
  assert.equal(isWithinQuietHours(quietHours, japanTime(2026, 11, 20, 12, 0)), false);
});

test("derives the Japan date key around the UTC day boundary", () => {
  assert.equal(japanDateKey(Date.parse("2026-11-19T14:59:59.999Z")), "2026-11-19");
  assert.equal(japanDateKey(Date.parse("2026-11-19T15:00:00.000Z")), "2026-11-20");
  assert.equal(japanDateKey(Date.parse("2026-11-20T14:59:59.999Z")), "2026-11-20");
  assert.equal(japanDateKey(japanTime(2026, 1, 1, 0, 0)), "2026-01-01");
});

test("returns today's Japan time as an epoch timestamp", () => {
  assert.equal(
    japanTimestampForToday("09:00", japanTime(2026, 11, 20, 8, 59)),
    japanTime(2026, 11, 20, 9, 0),
  );
  assert.equal(
    japanTimestampForToday("09:00", japanTime(2026, 11, 20, 23, 30)),
    japanTime(2026, 11, 20, 9, 0),
  );
  assert.equal(
    japanTimestampForToday("00:00", Date.parse("2026-11-19T14:59:59.999Z")),
    japanTime(2026, 11, 19, 0, 0),
  );
  assert.equal(
    japanTimestampForToday("00:00", Date.parse("2026-11-19T15:00:00.000Z")),
    japanTime(2026, 11, 20, 0, 0),
  );
});

test("checks whether the Japan day has reached a time", () => {
  assert.equal(isAtOrAfterJapanTime("09:00", japanTime(2026, 11, 20, 8, 59)), false);
  assert.equal(isAtOrAfterJapanTime("09:00", japanTime(2026, 11, 20, 9, 0)), true);
  assert.equal(isAtOrAfterJapanTime("09:00", japanTime(2026, 11, 20, 9, 1)), true);
  assert.equal(isAtOrAfterJapanTime("00:00", japanTime(2026, 11, 20, 0, 0)), true);
  assert.equal(isAtOrAfterJapanTime("23:59", japanTime(2026, 11, 20, 23, 58)), false);
});
