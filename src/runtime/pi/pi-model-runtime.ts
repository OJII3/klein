import { resolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 5_000;

const DEEPSEEK_V41_FLASH_FALLBACK: Model<"openai-completions"> = {
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  api: "openai-completions",
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  reasoning: true,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    max: "max",
  },
  input: ["text", "image"],
  cost: {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.003,
    cacheWrite: 0,
  },
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: "deepseek",
  },
};

const BUILTIN_MODEL_CATALOG = builtinModels();

export async function createPiModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: resolve(agentDir, "auth.json"),
    modelsPath: resolve(agentDir, "models.json"),
    modelsStorePath: resolve(agentDir, "models-store.json"),
    allowModelNetwork: true,
    modelRefreshTimeoutMs: MODEL_CATALOG_REFRESH_TIMEOUT_MS,
  });
}

export function resolveConfiguredModel(
  provider: string,
  modelId: string,
  modelCatalog: Pick<Models, "getModel"> = BUILTIN_MODEL_CATALOG,
): Model<Api> {
  const model = modelCatalog.getModel(provider, modelId);
  if (!model) {
    if (provider === "opencode-go" && modelId === DEEPSEEK_V41_FLASH_FALLBACK.id) {
      return DEEPSEEK_V41_FLASH_FALLBACK;
    }

    throw new Error(`Configured Pi model was not found: ${provider}/${modelId}`);
  }

  return model;
}

export function withOpenCodeSessionHeader(model: Model<Api>, sessionId: string): Model<Api> {
  if (model.provider !== "opencode" && model.provider !== "opencode-go") {
    return model;
  }

  return {
    ...model,
    headers: {
      ...model.headers,
      "x-opencode-session": sessionId,
    },
  };
}

export function resolveConfiguredImageModel(
  provider: string,
  modelId: string,
  modelCatalog: Pick<Models, "getModel"> = BUILTIN_MODEL_CATALOG,
): Model<Api> {
  const model = resolveConfiguredModel(provider, modelId, modelCatalog);
  if (!model.input.includes("image")) {
    throw new Error(
      `Configured Pi image model does not support image input: ${provider}/${modelId}`,
    );
  }

  return model;
}
