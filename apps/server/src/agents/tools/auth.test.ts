import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import type { AuthCredentialControl } from "@modules/auth/application/auth-credential-service";
import type {
  AuthCredentialSummary,
  AuthCredentialValues,
} from "@modules/auth/domain/auth-credential";
import type { AuthRequest } from "@modules/auth/domain/auth-request";
import { ensureUserEnvironment, resolveUserEnvironment } from "@shared/user-environment";
import { createTempDir } from "../../testing/temp-dir";
import { createAuthTools, type AuthCommandRunner } from "./auth";

const request: AuthRequest = {
  requestId: "request-1",
  userId: "123",
  channelId: "channel-1",
  accessScope: "user:123",
  workerId: "worker-1",
  service: "github",
  label: "GitHub",
  reason: "Issueを確認するため",
  fields: [{ key: "token", label: "トークン" }],
  createdAt: "2026-11-22T00:00:00.000Z",
  expiresAt: "2026-11-22T00:15:00.000Z",
};

const summary: AuthCredentialSummary = {
  service: "github",
  label: "GitHub",
  fields: [{ key: "token", label: "トークン" }],
  updatedAt: "2026-11-22T00:00:00.000Z",
};

const values: AuthCredentialValues = {
  ...summary,
  values: { token: "ghp_secret_value" },
};

const unusedRunCommand: AuthCommandRunner = async () => {
  throw new Error("runCommand is not used in this test");
};

test("requests credentials through the Discord flow", async () => {
  await using temp = await createTempDir("klein-auth-tools-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
  const requests: unknown[] = [];
  const credentials: Pick<AuthCredentialControl, "request" | "list" | "read"> = {
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
  };
  const tools = createAuthTools({
    credentials,
    userId: "123",
    channelId: "channel-1",
    accessScope: "user:123",
    workerId: "worker-1",
    environment,
    runCommand: unusedRunCommand,
  });
  const tool = tools.find((candidate) => candidate.name === "auth_request");
  assert.ok(tool);
  const ctx = await createStubExtensionToolContext();

  const result = await tool.execute(
    "tool-call",
    {
      service: "github",
      label: "GitHub",
      reason: "Issueを確認するため",
      fields: [{ key: "token", label: "トークン" }],
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
      fields: [{ key: "token", label: "トークン" }],
    },
  ]);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /direct message/u);
});

test("lists services without values", async () => {
  await using temp = await createTempDir("klein-auth-tools-list-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
  const credentials: Pick<AuthCredentialControl, "request" | "list" | "read"> = {
    async request() {
      return { kind: "unavailable" };
    },
    async list() {
      return [summary];
    },
    async read() {
      return undefined;
    },
  };
  const tools = createAuthTools({
    credentials,
    userId: "123",
    channelId: "channel-1",
    accessScope: "user:123",
    workerId: "worker-1",
    environment,
    runCommand: unusedRunCommand,
  });
  const tool = tools.find((candidate) => candidate.name === "auth_list");
  assert.ok(tool);
  const ctx = await createStubExtensionToolContext();

  const result = await tool.execute("tool-call", {}, undefined, undefined, ctx);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /github/u);
  assert.match(text, /KLEIN_AUTH_GITHUB_TOKEN/u);
  assert.doesNotMatch(text, /ghp_secret_value/u);
});

test("injects credential fields into the sandbox and redacts printed values", async () => {
  await using temp = await createTempDir("klein-auth-tools-run-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
  const seen: { environment: Readonly<Record<string, string>>; command: string }[] = [];
  const credentials: Pick<AuthCredentialControl, "request" | "list" | "read"> = {
    async request() {
      return { kind: "unavailable" };
    },
    async list() {
      return [summary];
    },
    async read() {
      return values;
    },
  };
  const tools = createAuthTools({
    credentials,
    userId: "123",
    channelId: "channel-1",
    accessScope: "user:123",
    workerId: "worker-1",
    environment,
    async runCommand(_environment, command, options) {
      seen.push({ environment: options?.credentialEnvironment ?? {}, command });
      return { output: `value=${values.values.token}\nexit`, exitCode: 0, truncated: false };
    },
  });
  const tool = tools.find((candidate) => candidate.name === "auth_run");
  assert.ok(tool);
  const ctx = await createStubExtensionToolContext();

  const result = await tool.execute(
    "tool-call",
    { service: "github", command: 'printf %s "$KLEIN_AUTH_GITHUB_TOKEN"' },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.environment, {
    KLEIN_AUTH_GITHUB_TOKEN: "ghp_secret_value",
  });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.doesNotMatch(text, /ghp_secret_value/u);
  assert.match(text, /\[redacted\]/u);
  assert.match(text, /KLEIN_AUTH_GITHUB_TOKEN/u);
});
