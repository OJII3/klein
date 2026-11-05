import assert from "node:assert/strict";
import test from "node:test";

import { formatMonthlyUsageStatus } from "./format-monthly-usage-status";

test("formats the remaining monthly usage and reset countdown", () => {
  assert.equal(
    formatMonthlyUsageStatus(
      {
        kind: "percentage",
        resetsAt: new Date("2026-10-01T14:00:00.000Z"),
        status: "ok",
        usedPercentage: 34.5,
      },
      new Date("2026-09-14T14:00:00.000Z"),
    ),
    "65.5%/month (reset in 17 days)",
  );
});

test("shows negative remaining percentage and omits reset when unavailable", () => {
  assert.equal(
    formatMonthlyUsageStatus(
      {
        kind: "percentage",
        status: "rate-limited",
        usedPercentage: 125,
      },
      new Date("2026-09-14T14:00:00.000Z"),
    ),
    "-25%/month",
  );
});

test("formats estimated monthly spend and reset countdown", () => {
  assert.equal(
    formatMonthlyUsageStatus(
      {
        kind: "cost",
        resetsAt: new Date("2026-10-01T00:00:00.000Z"),
        status: "ok",
        usedAmount: 1.234,
        currency: "USD",
      },
      new Date("2026-09-14T00:00:00.000Z"),
    ),
    "$1.23 this month (reset in 17 days)",
  );
});

test("formats estimated monthly spend without a reset date", () => {
  assert.equal(
    formatMonthlyUsageStatus({
      kind: "cost",
      status: "ok",
      usedAmount: 0,
      currency: "USD",
    }),
    "$0.00 this month",
  );
});
