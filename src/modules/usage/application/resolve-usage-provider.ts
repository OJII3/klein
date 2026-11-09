import type { AppConfig } from "@app/config-schema";
import { EstimatedUsageProvider } from "../infrastructure/estimated-usage-provider";
import { LangfuseUsageProvider } from "../infrastructure/langfuse-usage-provider";
import { OpenCodeGoUsageProvider } from "../infrastructure/opencode-go-usage-provider";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";

const GOOGLE_MONTHLY_BUDGET_USD = 10;
const MISTRAL_MONTHLY_BUDGET_USD = 150;
const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";

export interface LangfuseCredentials {
  readonly publicKey: string;
  readonly secretKey: string;
  readonly baseUrl?: string;
}

export interface ResolveUsageProviderInput {
  readonly agentDirectory: string;
  readonly provider: AppConfig["llm"]["provider"];
  readonly mistralModels: readonly string[];
  readonly langfuse?: LangfuseCredentials;
  readonly openCodeGoApiKey?: string;
}

export function resolveUsageProvider(
  input: ResolveUsageProviderInput,
): UsageLimitProvider | undefined {
  switch (input.provider) {
    case "google":
      return new EstimatedUsageProvider(input.agentDirectory, "google", GOOGLE_MONTHLY_BUDGET_USD);
    case "mistral":
      return input.langfuse && input.mistralModels.length > 0
        ? new LangfuseUsageProvider({
            baseUrl: input.langfuse.baseUrl ?? DEFAULT_LANGFUSE_BASE_URL,
            models: input.mistralModels,
            monthlyBudgetUsd: MISTRAL_MONTHLY_BUDGET_USD,
            publicKey: input.langfuse.publicKey,
            secretKey: input.langfuse.secretKey,
          })
        : new EstimatedUsageProvider(input.agentDirectory, "mistral", MISTRAL_MONTHLY_BUDGET_USD);
    case "opencode-go":
      return input.openCodeGoApiKey
        ? new OpenCodeGoUsageProvider(input.openCodeGoApiKey)
        : undefined;
  }
}
