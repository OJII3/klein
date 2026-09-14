import assert from "node:assert/strict";
import test from "node:test";

import { formatMonthlyUsageStatus } from "./format-monthly-usage-status.js";

test("formats the remaining monthly usage and reset countdown", () => {
  assert.equal(
    formatMonthlyUsageStatus(
      {
        resetsAt: new Date("2026-10-01T14:00:00.000Z"),
        status: "ok",
        usedPercentage: 34.5,
      },
      new Date("2026-09-14T14:00:00.000Z"),
    ),
    "65.5%/month (reset in 17 days)",
  );
});

test("does not show a negative remaining percentage or countdown", () => {
  assert.equal(
    formatMonthlyUsageStatus(
      {
        resetsAt: new Date("2026-09-14T13:00:00.000Z"),
        status: "rate-limited",
        usedPercentage: 100,
      },
      new Date("2026-09-14T14:00:00.000Z"),
    ),
    "0%/month (reset in 0 days)",
  );
});
