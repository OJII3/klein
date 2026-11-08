import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";
import { sumMonthlyProviderCost } from "./monthly-provider-cost";

export class MistralEstimatedUsageProvider implements UsageLimitProvider {
  constructor(
    private readonly agentDirectory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const now = this.now();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth());
    const usedAmount = await sumMonthlyProviderCost(this.agentDirectory, "mistral", monthStart);

    return {
      kind: "cost",
      status: "ok",
      usedAmount,
      currency: "USD",
      resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1)),
    };
  }
}
