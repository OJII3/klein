import assert from "node:assert/strict";
import test from "node:test";

import type { AuthCredentialSummary, AuthCredentialValues } from "../domain/auth-credential";
import type { AuthRequest } from "../domain/auth-request";
import type { AuthCredentialSaveInput, AuthCredentialStore } from "../ports/auth-credential-store";
import type { AuthRequestStore } from "../ports/auth-request-store";
import { AuthCredentialService } from "./auth-credential-service";

class MemoryRequestStore implements AuthRequestStore {
  readonly requests = new Map<string, AuthRequest>();

  async load(): Promise<void> {}

  list(): readonly AuthRequest[] {
    return [...this.requests.values()];
  }

  async save(request: AuthRequest): Promise<void> {
    this.requests.set(request.requestId, request);
  }

  async remove(requestId: string): Promise<void> {
    this.requests.delete(requestId);
  }
}

class MemoryCredentialStore implements AuthCredentialStore {
  readonly saved: { userId: string; input: AuthCredentialSaveInput }[] = [];

  async save(userId: string, input: AuthCredentialSaveInput): Promise<AuthCredentialSummary> {
    this.saved.push({ userId, input });
    return {
      service: input.service,
      label: input.label,
      fields: input.fields,
      updatedAt: input.updatedAt,
    };
  }

  async read(): Promise<AuthCredentialValues | undefined> {
    return undefined;
  }

  async list(): Promise<readonly AuthCredentialSummary[]> {
    return [];
  }

  async delete(): Promise<boolean> {
    return false;
  }
}

const draft = {
  userId: "123",
  channelId: "channel-1",
  accessScope: "user:123" as const,
  workerId: "worker-1",
  service: "github",
  label: "GitHub",
  reason: "Issueを確認するため",
  fields: [{ key: "token", label: "トークン" }],
};

function createHarness(now = new Date("2026-11-22T00:00:00.000Z")) {
  const requests = new MemoryRequestStore();
  const credentials = new MemoryCredentialStore();
  const resolved: { request: AuthRequest; outcome: "saved" | "cancelled" }[] = [];
  const service = new AuthCredentialService({
    credentials,
    requests,
    now: () => now,
    onResolved: async (request, outcome) => {
      resolved.push({ request, outcome });
    },
  });
  return { service, requests, credentials, resolved, now };
}

test("requests once and saves submitted values for the linked user", async () => {
  const harness = createHarness();
  const first = await harness.service.request(draft);
  assert.equal(first.kind, "requested");
  if (first.kind !== "requested") assert.fail("expected a requested outcome");

  const duplicate = await harness.service.request(draft);
  assert.equal(duplicate.kind, "pending");
  if (duplicate.kind !== "pending") assert.fail("expected a pending outcome");
  assert.equal(duplicate.request.requestId, first.request.requestId);

  const outcome = await harness.service.complete(first.request.requestId, "123", {
    token: "secret-token",
  });
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(harness.credentials.saved, [
    {
      userId: "123",
      input: {
        service: "github",
        label: "GitHub",
        fields: [{ key: "token", label: "トークン" }],
        values: { token: "secret-token" },
        updatedAt: "2026-11-22T00:00:00.000Z",
      },
    },
  ]);
  assert.equal(harness.requests.list().length, 0);
  assert.deepEqual(harness.resolved, [{ request: first.request, outcome: "saved" }]);
});

test("allows different workers to request the same service", async () => {
  const harness = createHarness();
  const first = await harness.service.request(draft);
  const second = await harness.service.request({
    ...draft,
    workerId: "worker-2",
    channelId: "channel-2",
  });

  assert.equal(first.kind, "requested");
  assert.equal(second.kind, "requested");
  if (first.kind !== "requested" || second.kind !== "requested") {
    assert.fail("expected both requests to be created");
  }
  assert.notEqual(first.request.requestId, second.request.requestId);
  assert.equal(harness.requests.list().length, 2);
});

test("allows only the requested user to complete or cancel", async () => {
  const harness = createHarness();
  const requested = await harness.service.request(draft);
  if (requested.kind !== "requested") assert.fail("expected a requested outcome");

  assert.equal(
    (await harness.service.complete(requested.request.requestId, "456", { token: "x" })).kind,
    "forbidden",
  );
  assert.equal(
    (await harness.service.cancel(requested.request.requestId, "456")).kind,
    "forbidden",
  );
  assert.equal(harness.requests.list().length, 1);

  assert.equal(
    (await harness.service.cancel(requested.request.requestId, "123")).kind,
    "cancelled",
  );
  assert.deepEqual(harness.resolved, [{ request: requested.request, outcome: "cancelled" }]);
});

test("expires a request before it can be completed", async () => {
  const now = new Date("2026-11-22T00:00:00.000Z");
  const harness = createHarness(now);
  const requested = await harness.service.request({ ...draft, expiresInMinutes: 1 });
  if (requested.kind !== "requested") assert.fail("expected a requested outcome");

  now.setTime(Date.parse("2026-11-22T00:01:01.000Z"));
  assert.equal(
    (await harness.service.complete(requested.request.requestId, "123", { token: "x" })).kind,
    "expired",
  );
  assert.equal(harness.requests.list().length, 0);
});

test("rejects values that do not match the request and mismatched scopes", async () => {
  const harness = createHarness();
  const mismatched = await harness.service.request({ ...draft, accessScope: "user:456" });
  assert.equal(mismatched.kind, "invalid");

  const requested = await harness.service.request({
    ...draft,
    fields: [
      { key: "token", label: "トークン" },
      { key: "username", label: "ユーザー名" },
    ],
  });
  if (requested.kind !== "requested") assert.fail("expected a requested outcome");

  assert.equal(
    (await harness.service.complete(requested.request.requestId, "123", { token: "x" })).kind,
    "invalid",
  );
  assert.equal(
    (
      await harness.service.complete(requested.request.requestId, "123", {
        token: "",
        username: "octocat",
      })
    ).kind,
    "invalid",
  );
  assert.equal(harness.requests.list().length, 1);
});

test("reports missing and expired requests", async () => {
  const now = new Date("2026-11-22T00:00:00.000Z");
  const harness = createHarness(now);
  const requested = await harness.service.request({ ...draft, expiresInMinutes: 1 });
  if (requested.kind !== "requested") assert.fail("expected a requested outcome");
  await harness.requests.remove("missing");

  assert.equal((await harness.service.lookupPending("missing")).kind, "missing");
  now.setTime(Date.parse("2026-11-22T00:02:00.000Z"));
  assert.equal((await harness.service.lookupPending(requested.request.requestId)).kind, "expired");
});
