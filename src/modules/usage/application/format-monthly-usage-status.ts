import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

export function formatMonthlyUsageStatus(
  monthly: MonthlyUsageLimit,
  now: Date = new Date(),
): string {
  const remainingPercentage = Math.max(0, 100 - monthly.usedPercentage);
  const resetInDays = Math.max(
    0,
    Math.ceil((monthly.resetsAt.getTime() - now.getTime()) / MILLISECONDS_PER_DAY),
  );

  return `${formatPercentage(remainingPercentage)}/month (reset in ${resetInDays} days)`;
}
