import { resolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 5_000;

const BUILTIN_MODEL_CATALOG = builtinModels();

interface ModelCatalog {
  getModel(provider: string, modelId: string): Model<Api> | undefined;
  refresh(options: {
    force?: boolean;
    providers?: readonly string[];
    signal?: AbortSignal;
  }): Promise<{ aborted?: boolean } | void>;
}

interface ConfiguredModelRef {
  readonly provider: string;
  readonly model: string;
}

export async function createPiModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: resolve(agentDir, "auth.json"),
    modelsPath: resolve(agentDir, "models.json"),
    modelsStorePath: resolve(agentDir, "models-store.json"),
    allowModelNetwork: true,
    modelRefreshTimeoutMs: MODEL_CATALOG_REFRESH_TIMEOUT_MS,
  });
}

/**
 * Refresh the catalog once when a configured model is missing, then fail with the
 * missing models instead of substituting hand-maintained model metadata.
 */
export async function ensureConfiguredModels(
  modelCatalog: ModelCatalog,
  models: readonly ConfiguredModelRef[],
): Promise<void> {
  const missing = models.filter(
    ({ provider, model }) => modelCatalog.getModel(provider, model) === undefined,
  );
  if (missing.length === 0) return;

  const result = await modelCatalog.refresh({
    force: true,
    providers: [...new Set(missing.map(({ provider }) => provider))],
    signal: AbortSignal.timeout(MODEL_CATALOG_REFRESH_TIMEOUT_MS),
  });

  const unresolved = missing.filter(
    ({ provider, model }) => modelCatalog.getModel(provider, model) === undefined,
  );
  if (unresolved.length === 0) return;

  const names = unresolved.map(({ provider, model }) => `${provider}/${model}`).join(", ");
  throw new Error(
    result?.aborted
      ? `Configured Pi model was not found and the catalog refresh timed out: ${names}`
      : `Configured Pi model was not found after refreshing the catalog: ${names}`,
  );
}

export function resolveConfiguredModel(
  provider: string,
  modelId: string,
  modelCatalog: Pick<Models, "getModel"> = BUILTIN_MODEL_CATALOG,
): Model<Api> {
  const model = modelCatalog.getModel(provider, modelId);
  if (!model) {
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
