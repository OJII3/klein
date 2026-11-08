import ky from "ky";
import { Check, Errors } from "typebox/value";
import { Type, type Static } from "typebox";

import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";

const OPENCODE_CONSOLE_USAGE_URL = "https://opencode.ai/console/api/usage/models";
const OPENCODE_CONSOLE_USAGE_TIMEOUT_MS = 10_000;
const MICRO_CENTS_PER_USD = 100_000_000;
const MONTHLY_BUDGET_USD = 150;

const UsageModelSchema = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  totalCostMicroCents: Type.String({ pattern: "^\\d+$" }),
});

const UsageModelsResponseSchema = Type.Object({
  items: Type.Array(UsageModelSchema),
});

type UsageModelsResponse = Static<typeof UsageModelsResponseSchema>;

function formatValidationErrors(value: unknown): string {
  return [...Errors(UsageModelsResponseSchema, value)]
    .slice(0, 3)
    .map((error) => `${error.instancePath || "$"}: ${error.message}`)
    .join("; ");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class MistralConsoleUsageProvider implements UsageLimitProvider {
  constructor(
    private readonly apiKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const now = this.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1));
    const response = await ky
      .get(OPENCODE_CONSOLE_USAGE_URL, {
        searchParams: {
          from: formatDate(monthStart),
          to: formatDate(monthEnd),
          pageSize: "100",
        },
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "klein/0.1.0",
        },
        retry: {
          limit: 1,
          methods: ["get"],
        },
        timeout: OPENCODE_CONSOLE_USAGE_TIMEOUT_MS,
      })
      .json<unknown>();

    if (!Check(UsageModelsResponseSchema, response)) {
      throw new Error(
        `OpenCode Console usage response is invalid: ${formatValidationErrors(response)}`,
      );
    }

    const microCents = (response as UsageModelsResponse).items
      .filter((item) => item.provider === "mistral")
      .reduce((total, item) => total + Number(item.totalCostMicroCents), 0);
    const cost = microCents / MICRO_CENTS_PER_USD;

    return {
      status: "ok",
      usedPercentage: (cost / MONTHLY_BUDGET_USD) * 100,
      resetsAt: monthEnd,
    };
  }
}
