import type { ConfiguredModel } from "./model-configuration";

export interface EnvironmentCredentials {
  readonly discordBotToken: string;
  readonly openCodeGoApiKey?: string;
  readonly tunnelToken?: string;
  readonly usage?: {
    readonly endpoint: string;
    readonly token: string;
  };
}

export interface ResolveCredentialsInput {
  readonly modelsInUse: readonly ConfiguredModel[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

function optionalValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return environment[name] || undefined;
}

export function resolveCredentials({
  modelsInUse,
  environment,
}: ResolveCredentialsInput): EnvironmentCredentials {
  const discordBotToken = optionalValue(environment, "DISCORD_BOT_TOKEN");
  if (!discordBotToken) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }

  const openCodeGoApiKey = optionalValue(environment, "OPENCODE_API_KEY");
  if (!openCodeGoApiKey && modelsInUse.some((model) => model.provider === "opencode-go")) {
    throw new Error("OPENCODE_API_KEY is required");
  }

  const usageEndpoint = optionalValue(environment, "USAGE_ENDPOINT");
  const usageToken = optionalValue(environment, "USAGE_TOKEN");
  const usage =
    usageEndpoint && usageToken ? { endpoint: usageEndpoint, token: usageToken } : undefined;
  const tunnelToken = optionalValue(environment, "TUNNEL_TOKEN");

  return {
    discordBotToken,
    ...(openCodeGoApiKey ? { openCodeGoApiKey } : {}),
    ...(tunnelToken ? { tunnelToken } : {}),
    ...(usage ? { usage } : {}),
  };
}
