import ky from "ky";
import { Check, Errors } from "typebox/value";
import { Type } from "typebox";

import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";

const OPENCODE_USAGE_TIMEOUT_MS = 10_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;

const UsageRowSchema = Type.Object({
  provider: Type.String(),
  cost: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

const UsageResponseSchema = Type.Object({
  rows: Type.Array(UsageRowSchema),
});

export interface OpenCodeUsageProviderOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly provider: string;
  readonly monthlyBudgetUsd: number;
  readonly now?: () => Date;
}

function formatValidationErrors(value: unknown): string {
  return [...Errors(UsageResponseSchema, value)]
    .slice(0, 3)
    .map((error) => `${error.instancePath || "$"}: ${error.message}`)
    .join("; ");
}

function usageUrl(endpoint: string): URL {
  return new URL("/usage", endpoint);
}

export class OpenCodeUsageProvider implements UsageLimitProvider {
  constructor(private readonly options: OpenCodeUsageProviderOptions) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const now = this.options.now?.() ?? new Date();
    // The worker counts `days` in JST, so the JST day of month covers the
    // current month from its first day through today.
    const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
    const days = jstNow.getUTCDate();
    const resetsAt = new Date(
      Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() + 1) - JST_OFFSET_MS,
    );

    const url = usageUrl(this.options.endpoint);
    url.searchParams.set("days", String(days));

    const response = await ky
      .get(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.options.token}`,
        },
        retry: {
          limit: 1,
          methods: ["get"],
        },
        timeout: OPENCODE_USAGE_TIMEOUT_MS,
      })
      .json<unknown>();

    if (!Check(UsageResponseSchema, response)) {
      throw new Error(`opencode-usage response is invalid: ${formatValidationErrors(response)}`);
    }

    const cost = response.rows
      .filter((row) => row.provider === this.options.provider)
      .reduce((total, row) => total + (row.cost ?? 0), 0);

    return {
      status: "ok",
      usedPercentage: (cost / this.options.monthlyBudgetUsd) * 100,
      resetsAt,
    };
  }
}
