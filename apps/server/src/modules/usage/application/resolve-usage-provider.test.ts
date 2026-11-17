import assert from "node:assert/strict";
import test from "node:test";

import { EstimatedUsageProvider } from "../infrastructure/estimated-usage-provider";
import { OpenCodeGoUsageProvider } from "../infrastructure/opencode-go-usage-provider";
import { OpenCodeUsageProvider } from "../infrastructure/opencode-usage-provider";
import { resolveUsageProvider, type ResolveUsageProviderInput } from "./resolve-usage-provider";

const AGENT_DIRECTORY = "/tmp/klein-agent";
const USAGE_CREDENTIALS = {
  endpoint: "https://usage.local/ingest",
  token: "usage-token",
};

function createInput(overrides: Partial<ResolveUsageProviderInput>): ResolveUsageProviderInput {
  return {
    agentDirectory: AGENT_DIRECTORY,
    provider: "google",
    ...overrides,
  };
}

test("estimates Google spend from local session usage", () => {
  assert.ok(
    resolveUsageProvider(createInput({ provider: "google" })) instanceof EstimatedUsageProvider,
  );
});

test("reads Google spend from opencode-usage when credentials are available", () => {
  const provider = resolveUsageProvider(
    createInput({
      provider: "google",
      usage: USAGE_CREDENTIALS,
    }),
  );

  assert.ok(provider instanceof OpenCodeUsageProvider);
});

test("estimates Mistral spend when opencode-usage credentials are missing", () => {
  const provider = resolveUsageProvider(createInput({ provider: "mistral" }));

  assert.ok(provider instanceof EstimatedUsageProvider);
});

test("reads Mistral spend from opencode-usage when credentials are available", () => {
  const provider = resolveUsageProvider(
    createInput({
      provider: "mistral",
      usage: USAGE_CREDENTIALS,
    }),
  );

  assert.ok(provider instanceof OpenCodeUsageProvider);
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
