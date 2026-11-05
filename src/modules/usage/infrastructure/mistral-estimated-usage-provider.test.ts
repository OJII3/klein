import assert from "node:assert/strict";
import test from "node:test";

import { MistralEstimatedUsageProvider } from "./mistral-estimated-usage-provider";

test("estimates the current month's Mistral spend from durable usage", async () => {
  let requestedMonthStart: number | undefined;
  const provider = new MistralEstimatedUsageProvider(
    async (monthStart) => {
      requestedMonthStart = monthStart;
      return 1.234;
    },
    () => new Date("2026-09-14T14:00:00.000Z"),
  );

  const usage = await provider.getMonthlyUsageLimit();

  assert.equal(requestedMonthStart, Date.UTC(2026, 8));
  assert.deepEqual(usage, {
    kind: "cost",
    resetsAt: new Date(Date.UTC(2026, 9)),
    status: "ok",
    usedAmount: 1.234,
    currency: "USD",
  });
});
