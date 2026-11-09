import type { AppConfig } from "@app/config-schema";
import { EstimatedUsageProvider } from "../infrastructure/estimated-usage-provider";
import { OpenCodeGoUsageProvider } from "../infrastructure/opencode-go-usage-provider";
import { OpenCodeUsageProvider } from "../infrastructure/opencode-usage-provider";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";

const GOOGLE_MONTHLY_BUDGET_USD = 10;
const MISTRAL_MONTHLY_BUDGET_USD = 150;

export interface UsageApiCredentials {
  readonly endpoint: string;
  readonly token: string;
}

export interface ResolveUsageProviderInput {
  readonly agentDirectory: string;
  readonly provider: AppConfig["llm"]["provider"];
  readonly usage?: UsageApiCredentials;
  readonly openCodeGoApiKey?: string;
}

export function resolveUsageProvider(
  input: ResolveUsageProviderInput,
): UsageLimitProvider | undefined {
  switch (input.provider) {
    case "google":
      return input.usage
        ? new OpenCodeUsageProvider({
            endpoint: input.usage.endpoint,
            provider: "google",
            monthlyBudgetUsd: GOOGLE_MONTHLY_BUDGET_USD,
            token: input.usage.token,
          })
        : new EstimatedUsageProvider(input.agentDirectory, "google", GOOGLE_MONTHLY_BUDGET_USD);
    case "mistral":
      return input.usage
        ? new OpenCodeUsageProvider({
            endpoint: input.usage.endpoint,
            provider: "mistral",
            monthlyBudgetUsd: MISTRAL_MONTHLY_BUDGET_USD,
            token: input.usage.token,
          })
        : new EstimatedUsageProvider(input.agentDirectory, "mistral", MISTRAL_MONTHLY_BUDGET_USD);
    case "opencode-go":
      return input.openCodeGoApiKey
        ? new OpenCodeGoUsageProvider(input.openCodeGoApiKey)
        : undefined;
  }
}
