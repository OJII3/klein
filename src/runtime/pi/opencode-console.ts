import ky from "ky";
import { Check, Errors } from "typebox/value";
import { Type, type Static, type TSchema } from "typebox";

const OPENCODE_CONSOLE_API_URL = "https://opencode.ai/console/api";
const OPENCODE_CONSOLE_TIMEOUT_MS = 10_000;

const ConsoleProviderSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  enabled: Type.Boolean(),
  catalogSlug: Type.String({ minLength: 1 }),
});

const ConsoleProvidersSchema = Type.Array(ConsoleProviderSchema);

const ConsoleProviderDetailSchema = Type.Object({
  requestBaseUrl: Type.String({ format: "uri" }),
});

type ConsoleProvider = Static<typeof ConsoleProviderSchema>;

function formatValidationErrors(schema: TSchema, value: unknown): string {
  return [...Errors(schema, value)]
    .slice(0, 3)
    .map((error) => `${error.instancePath || "$"}: ${error.message}`)
    .join("; ");
}

async function getConsole(path: string, apiKey: string): Promise<unknown> {
  return ky
    .get(`${OPENCODE_CONSOLE_API_URL}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "klein/0.1.0",
      },
      retry: {
        limit: 1,
        methods: ["get"],
      },
      timeout: OPENCODE_CONSOLE_TIMEOUT_MS,
    })
    .json<unknown>();
}

function selectMistralConnection(
  providers: readonly ConsoleProvider[],
): ConsoleProvider | undefined {
  const connections = providers.filter(
    (provider) => provider.enabled && provider.catalogSlug === "mistral",
  );
  if (connections.length > 1) {
    throw new Error(
      "Multiple enabled Mistral connections found; set MISTRAL_CONSOLE_URL to choose one",
    );
  }

  return connections[0];
}

export async function resolveMistralConnectionUrl(apiKey: string): Promise<string | undefined> {
  const providers = await getConsole("/providers", apiKey);
  if (!Check(ConsoleProvidersSchema, providers)) {
    throw new Error(
      `OpenCode Console providers response is invalid: ${formatValidationErrors(ConsoleProvidersSchema, providers)}`,
    );
  }

  const connection = selectMistralConnection(providers as ConsoleProvider[]);
  if (!connection) {
    return undefined;
  }

  const detail = await getConsole(`/providers/${connection.id}`, apiKey);
  if (!Check(ConsoleProviderDetailSchema, detail)) {
    throw new Error(
      `OpenCode Console provider response is invalid: ${formatValidationErrors(ConsoleProviderDetailSchema, detail)}`,
    );
  }

  return (detail as Static<typeof ConsoleProviderDetailSchema>).requestBaseUrl;
}
