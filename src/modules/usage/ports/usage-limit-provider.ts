import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit.js";

export interface UsageLimitProvider {
  getMonthlyUsageLimit(): Promise<MonthlyUsageLimit>;
}
