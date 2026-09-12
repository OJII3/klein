import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit.js";
import type { UsageLimitProvider } from "../ports/usage-limit-provider.js";

export type GetMonthlyUsageLimit = () => Promise<MonthlyUsageLimit>;

export function createGetMonthlyUsageLimit(provider: UsageLimitProvider): GetMonthlyUsageLimit {
  return () => provider.getMonthlyUsageLimit();
}
