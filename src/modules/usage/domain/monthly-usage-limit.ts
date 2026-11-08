export type MonthlyUsageLimitStatus = "ok" | "rate-limited";

interface BaseMonthlyUsageLimit {
  readonly status: MonthlyUsageLimitStatus;
  readonly resetsAt?: Date;
}

export interface PercentageMonthlyUsageLimit extends BaseMonthlyUsageLimit {
  readonly kind: "percentage";
  readonly usedPercentage: number;
}

export interface CostMonthlyUsageLimit extends BaseMonthlyUsageLimit {
  readonly kind: "cost";
  readonly usedAmount: number;
  readonly currency: string;
}

export type MonthlyUsageLimit = PercentageMonthlyUsageLimit | CostMonthlyUsageLimit;
