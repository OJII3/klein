import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import type { SecretControl } from "@modules/secrets/application/secret-service";
import type { SecretSummary, SecretValues } from "@modules/secrets/domain/secret";
import type { SecretRequest } from "@modules/secrets/domain/secret-request";
import { createSecretTools, type SecretCommandRunner } from "./secrets";

const request: SecretRequest = {
  requestId: "request-1",
  userId: "123",
  channelId: "channel-1",
  accessScope: "user:123",
  workerId: "worker-1",
  service: "github",
  label: "GitHub",
  reason: "Issueを確認するため",
  fields: [{ key: "token", label: "トークン", env: "GH_TOKEN" }],
  createdAt: "2026-11-22T00:00:00.000Z",
  expiresAt: "2026-11-22T00:15:00.000Z",
};

const summary: SecretSummary = {
  service: "github",
  label: "GitHub",
  fields: [{ key: "token", label: "トークン", env: "GH_TOKEN" }],
  updatedAt: "2026-11-22T00:00:00.000Z",
};

const values: SecretValues = {
  ...summary,
  values: { token: "ghp_secret_value" },
};

const unusedRunCommand: SecretCommandRunner = async () => {
  throw new Error("runCommand is not used in this test");
};

test("requests secrets through the Discord flow", async () => {
  const requests: unknown[] = [];
  const secrets: Pick<SecretControl, "request" | "list" | "read" | "delete"> = {
    async request(draft) {
      requests.push(draft);
      return { kind: "requested", request };
    },
    async list() {
      return [summary];
    },
    async read() {
      return values;
    },
    async delete() {
      return false;
    },
  };
  const tools = createSecretTools({
    secrets,
    userId: "123",
    channelId: "channel-1",
    accessScope: "user:123",
    workerId: "worker-1",
    runCommand: unusedRunCommand,
  });
  const tool = tools.find((candidate) => candidate.name === "secret_request");
  assert.ok(tool);
  const ctx = await createStubExtensionToolContext();

  const result = await tool.execute(
    "tool-call",
    {
      service: "github",
      label: "GitHub",
      reason: "Issueを確認するため",
      fields: [{ key: "token", label: "トークン", env: "GH_TOKEN" }],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.deepEqual(requests, [
    {
      userId: "123",
      channelId: "channel-1",
      accessScope: "user:123",
      workerId: "worker-1",
      service: "github",
      label: "GitHub",
      reason: "Issueを確認するため",
      fields: [{ key: "token", label: "トークン", env: "GH_TOKEN" }],
    },
  ]);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /direct message/u);
});

test("lists services without values", async () => {
  const secrets: Pick<SecretControl, "request" | "list" | "read" | "delete"> = {
    async request() {
      return { kind: "unavailable" };
    },
    async list() {
      return [summary];
    },
    async read() {
      return undefined;
    },
    async delete() {
      return false;
    },
  };
  const tools = createSecretTools({
    secrets,
    userId: "123",
    channelId: "channel-1",
    accessScope: "user:123",
    workerId: "worker-1",
    runCommand: unusedRunCommand,
  });
  const tool = tools.find((candidate) => candidate.name === "secret_list");
  assert.ok(tool);
  const ctx = await createStubExtensionToolContext();

  const result = await tool.execute("tool-call", {}, undefined, undefined, ctx);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /github/u);
  assert.match(text, /KLEIN_SECRET_GITHUB_TOKEN/u);
  assert.match(text, /GH_TOKEN/u);
  assert.doesNotMatch(text, /ghp_secret_value/u);
});

test("injects secret fields into the shell and redacts printed values", async () => {
  const seen: { environment: Readonly<Record<string, string>>; command: string }[] = [];
  const secrets: Pick<SecretControl, "request" | "list" | "read" | "delete"> = {
    async request() {
      return { kind: "unavailable" };
    },
    async list() {
      return [summary];
    },
    async read() {
      return values;
    },
    async delete() {
      return false;
    },
  };
  const tools = createSecretTools({
    secrets,
    userId: "123",
    channelId: "channel-1",
    accessScope: "user:123",
    workerId: "worker-1",
    async runCommand(command, options) {
      seen.push({ environment: options?.secretEnvironment ?? {}, command });
      return { output: `value=${values.values.token}\nexit`, exitCode: 0, truncated: false };
    },
  });
  const tool = tools.find((candidate) => candidate.name === "secret_run");
  assert.ok(tool);
  const ctx = await createStubExtensionToolContext();

  const result = await tool.execute(
    "tool-call",
    { service: "github", command: 'printf %s "$KLEIN_SECRET_GITHUB_TOKEN"' },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.environment, {
    KLEIN_SECRET_GITHUB_TOKEN: "ghp_secret_value",
    GH_TOKEN: "ghp_secret_value",
  });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.doesNotMatch(text, /ghp_secret_value/u);
  assert.match(text, /\[redacted\]/u);
  assert.match(text, /KLEIN_SECRET_GITHUB_TOKEN/u);
});

test("deletes saved secrets only for the linked user", async () => {
  const deleted: { userId: string; service: string }[] = [];
  const secrets: Pick<SecretControl, "request" | "list" | "read" | "delete"> = {
    async request() {
      return { kind: "unavailable" };
    },
    async list() {
      return [summary];
    },
    async read() {
      return undefined;
    },
    async delete(userId, service) {
      deleted.push({ userId, service });
      return true;
    },
  };
  const tools = createSecretTools({
    secrets,
    userId: "123",
    channelId: "channel-1",
    accessScope: "user:123",
    workerId: "worker-1",
    runCommand: unusedRunCommand,
  });
  const tool = tools.find((candidate) => candidate.name === "secret_delete");
  assert.ok(tool);
  const ctx = await createStubExtensionToolContext();

  const result = await tool.execute("tool-call", { service: "github" }, undefined, undefined, ctx);

  assert.deepEqual(deleted, [{ userId: "123", service: "github" }]);
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /Deleted the saved secrets/u,
  );
});
