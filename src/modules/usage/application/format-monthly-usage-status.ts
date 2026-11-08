import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function formatResetSuffix(resetsAt: Date | undefined, now: Date): string {
  if (!resetsAt) return "";
  const resetInDays = Math.max(
    0,
    Math.ceil((resetsAt.getTime() - now.getTime()) / MILLISECONDS_PER_DAY),
  );
  return ` (reset in ${resetInDays} days)`;
}

export function formatMonthlyUsageStatus(
  monthly: MonthlyUsageLimit,
  now: Date = new Date(),
): string {
  if (monthly.kind === "cost") {
    const amount = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: monthly.currency,
    }).format(monthly.usedAmount);
    return `${amount} this month${formatResetSuffix(monthly.resetsAt, now)}`;
  }

  const remainingPercentage = 100 - monthly.usedPercentage;
  return `${formatPercentage(remainingPercentage)}/month${formatResetSuffix(monthly.resetsAt, now)}`;
}
