import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";

export interface UsageLimitProvider {
  getMonthlyUsageLimit(): Promise<MonthlyUsageLimit>;
}
