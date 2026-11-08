import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";
import { sumMonthlyProviderCost } from "./monthly-provider-cost";

const MONTHLY_BUDGET_USD = 10;

export class VertexAiEstimatedUsageProvider implements UsageLimitProvider {
  constructor(private readonly agentDirectory: string) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth());
    const cost = await sumMonthlyProviderCost(this.agentDirectory, "google-vertex", monthStart);

    return {
      kind: "percentage",
      status: "ok",
      usedPercentage: (cost / MONTHLY_BUDGET_USD) * 100,
    };
  }
}
