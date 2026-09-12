import ky from "ky";
import { Check, Errors } from "typebox/value";
import { Type, type Static } from "typebox";

import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit.js";
import type { UsageLimitProvider } from "../ports/usage-limit-provider.js";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_USAGE_TIMEOUT_MS = 10_000;

const UsageWindowSchema = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("rate-limited")]),
  percent: Type.Number({ minimum: 0, maximum: 100 }),
  resetsAt: Type.String({ format: "date-time" }),
});

const OpenCodeGoUsageResponseSchema = Type.Object({
  usage: Type.Object({
    monthly: UsageWindowSchema,
  }),
});

type OpenCodeGoUsageResponse = Static<typeof OpenCodeGoUsageResponseSchema>;

function formatValidationErrors(value: unknown): string {
  return [...Errors(OpenCodeGoUsageResponseSchema, value)]
    .slice(0, 3)
    .map((error) => `${error.instancePath || "$"}: ${error.message}`)
    .join("; ");
}

export class OpenCodeGoUsageProvider implements UsageLimitProvider {
  constructor(private readonly apiKey: string) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const response = await ky
      .get(OPENCODE_GO_USAGE_URL, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "klein/0.1.0",
        },
        retry: {
          limit: 1,
          methods: ["get"],
        },
        timeout: OPENCODE_GO_USAGE_TIMEOUT_MS,
      })
      .json<unknown>();

    if (!Check(OpenCodeGoUsageResponseSchema, response)) {
      throw new Error(`OpenCode Go usage response is invalid: ${formatValidationErrors(response)}`);
    }

    const monthly = (response as OpenCodeGoUsageResponse).usage.monthly;
    const resetsAt = new Date(monthly.resetsAt);
    if (Number.isNaN(resetsAt.getTime())) {
      throw new Error("OpenCode Go usage response contains an invalid reset timestamp");
    }

    return {
      resetsAt,
      status: monthly.status,
      usedPercentage: monthly.percent,
    };
  }
}
