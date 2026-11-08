import ky from "ky";
import { Check, Errors } from "typebox/value";
import { Type } from "typebox";

import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";

const LANGFUSE_USAGE_TIMEOUT_MS = 10_000;

const LangfuseMetricsResponseSchema = Type.Object({
  data: Type.Array(
    Type.Object({
      sum_totalCost: Type.Optional(Type.Number()),
    }),
  ),
});

export interface LangfuseUsageProviderOptions {
  readonly baseUrl: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly models: readonly string[];
  readonly monthlyBudgetUsd: number;
  readonly now?: () => Date;
}

function formatValidationErrors(value: unknown): string {
  return [...Errors(LangfuseMetricsResponseSchema, value)]
    .slice(0, 3)
    .map((error) => `${error.instancePath || "$"}: ${error.message}`)
    .join("; ");
}

export class LangfuseUsageProvider implements UsageLimitProvider {
  constructor(private readonly options: LangfuseUsageProviderOptions) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const now = this.options.now?.() ?? new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()));
    const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1));

    const url = new URL(`${this.options.baseUrl.replace(/\/+$/, "")}/api/public/v2/metrics`);
    url.searchParams.set(
      "query",
      JSON.stringify({
        view: "observations",
        metrics: [{ measure: "totalCost", aggregation: "sum" }],
        filters: [
          {
            column: "providedModelName",
            operator: "any of",
            type: "stringOptions",
            value: this.options.models,
          },
        ],
        fromTimestamp: monthStart.toISOString(),
        toTimestamp: resetsAt.toISOString(),
      }),
    );

    const response = await ky
      .get(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(
            `${this.options.publicKey}:${this.options.secretKey}`,
          ).toString("base64")}`,
        },
        retry: {
          limit: 1,
          methods: ["get"],
        },
        timeout: LANGFUSE_USAGE_TIMEOUT_MS,
      })
      .json<unknown>();

    if (!Check(LangfuseMetricsResponseSchema, response)) {
      throw new Error(`Langfuse usage response is invalid: ${formatValidationErrors(response)}`);
    }

    const cost = response.data.reduce((total, row) => total + (row.sum_totalCost ?? 0), 0);

    return {
      status: "ok",
      usedPercentage: (cost / this.options.monthlyBudgetUsd) * 100,
      resetsAt,
    };
  }
}
