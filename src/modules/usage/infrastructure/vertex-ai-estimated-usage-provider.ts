import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";

const MONTHLY_BUDGET_USD = 10;

export class VertexAiEstimatedUsageProvider implements UsageLimitProvider {
  constructor(private readonly getDurableCost: (monthStart: number) => Promise<number>) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth());
    const cost = await this.getDurableCost(monthStart);

    return {
      status: "ok",
      usedPercentage: (cost / MONTHLY_BUDGET_USD) * 100,
    };
  }
}
