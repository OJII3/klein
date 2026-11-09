import assert from "node:assert/strict";
import test from "node:test";

import { EstimatedUsageProvider } from "../infrastructure/estimated-usage-provider";
import { LangfuseUsageProvider } from "../infrastructure/langfuse-usage-provider";
import { OpenCodeGoUsageProvider } from "../infrastructure/opencode-go-usage-provider";
import { resolveUsageProvider, type ResolveUsageProviderInput } from "./resolve-usage-provider";

const AGENT_DIRECTORY = "/tmp/klein-agent";
const LANGFUSE_CREDENTIALS = {
  publicKey: "langfuse-public-key",
  secretKey: "langfuse-secret-key",
};

function createInput(overrides: Partial<ResolveUsageProviderInput>): ResolveUsageProviderInput {
  return {
    agentDirectory: AGENT_DIRECTORY,
    provider: "google",
    googleModels: [],
    mistralModels: [],
    ...overrides,
  };
}

test("estimates Google spend from local session usage", () => {
  assert.ok(
    resolveUsageProvider(createInput({ provider: "google" })) instanceof EstimatedUsageProvider,
  );
});

test("reads Google spend from Langfuse when credentials and models are available", () => {
  const provider = resolveUsageProvider(
    createInput({
      provider: "google",
      googleModels: ["gemini-3-pro-preview"],
      langfuse: LANGFUSE_CREDENTIALS,
    }),
  );

  assert.ok(provider instanceof LangfuseUsageProvider);
});

test("estimates Google spend when Langfuse credentials are missing", () => {
  const provider = resolveUsageProvider(
    createInput({ provider: "google", googleModels: ["gemini-3-pro-preview"] }),
  );

  assert.ok(provider instanceof EstimatedUsageProvider);
});

test("reads Mistral spend from Langfuse when credentials and models are available", () => {
  const provider = resolveUsageProvider(
    createInput({
      provider: "mistral",
      mistralModels: ["mistral-model"],
      langfuse: LANGFUSE_CREDENTIALS,
    }),
  );

  assert.ok(provider instanceof LangfuseUsageProvider);
});

test("estimates Mistral spend when Langfuse credentials are missing", () => {
  const provider = resolveUsageProvider(
    createInput({ provider: "mistral", mistralModels: ["mistral-model"] }),
  );

  assert.ok(provider instanceof EstimatedUsageProvider);
});

test("estimates Mistral spend when no Mistral model is in use", () => {
  const provider = resolveUsageProvider(
    createInput({ provider: "mistral", langfuse: LANGFUSE_CREDENTIALS }),
  );

  assert.ok(provider instanceof EstimatedUsageProvider);
});

test("reads OpenCode Go usage when the API key is available", () => {
  const provider = resolveUsageProvider(
    createInput({ provider: "opencode-go", openCodeGoApiKey: "opencode-api-key" }),
  );

  assert.ok(provider instanceof OpenCodeGoUsageProvider);
});

test("reports no usage when the OpenCode Go API key is missing", () => {
  assert.equal(resolveUsageProvider(createInput({ provider: "opencode-go" })), undefined);
});
