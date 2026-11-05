import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";

export class MistralEstimatedUsageProvider implements UsageLimitProvider {
  constructor(
    private readonly getDurableCost: (monthStart: number) => Promise<number>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const now = this.now();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth());
    const cost = await this.getDurableCost(monthStart);

    return {
      kind: "cost",
      status: "ok",
      usedAmount: cost,
      currency: "USD",
      resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1)),
    };
  }
}
