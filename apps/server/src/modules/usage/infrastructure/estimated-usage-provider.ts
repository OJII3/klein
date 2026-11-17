import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";
import { sumMonthlyProviderCost } from "./monthly-provider-cost";

export class EstimatedUsageProvider implements UsageLimitProvider {
  constructor(
    private readonly agentDirectory: string,
    private readonly provider: string,
    private readonly monthlyBudgetUsd: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const now = this.now();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth());
    const cost = await sumMonthlyProviderCost(this.agentDirectory, this.provider, monthStart);

    return {
      status: "ok",
      usedPercentage: (cost / this.monthlyBudgetUsd) * 100,
      resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1)),
    };
  }
}
