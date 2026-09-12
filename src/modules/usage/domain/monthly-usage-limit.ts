export type MonthlyUsageLimitStatus = "ok" | "rate-limited";

export interface MonthlyUsageLimit {
  readonly status: MonthlyUsageLimitStatus;
  readonly usedPercentage: number;
  readonly resetsAt: Date;
}
