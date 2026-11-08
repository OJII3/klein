import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";
import { sumMonthlyProviderCost } from "./monthly-provider-cost";

const MONTHLY_BUDGET_USD = 150;

export class MistralEstimatedUsageProvider implements UsageLimitProvider {
  constructor(
    private readonly agentDirectory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const now = this.now();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth());
    const cost = await sumMonthlyProviderCost(this.agentDirectory, "mistral", monthStart);

    return {
      status: "ok",
      usedPercentage: (cost / MONTHLY_BUDGET_USD) * 100,
      resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1)),
    };
  }
}
