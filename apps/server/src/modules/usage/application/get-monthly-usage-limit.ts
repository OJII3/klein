import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";

export type GetMonthlyUsageLimit = () => Promise<MonthlyUsageLimit>;

export function createGetMonthlyUsageLimit(provider: UsageLimitProvider): GetMonthlyUsageLimit {
  return () => provider.getMonthlyUsageLimit();
}
