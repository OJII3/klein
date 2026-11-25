import assert from "node:assert/strict";
import test from "node:test";

import { CodingBackendRegistry } from "./coding-backend-registry";
import type { CodingBackend } from "../ports/coding-backend";

function createBackend(id: string): CodingBackend {
  return {
    id,
    label: id,
    capabilities: {
      projects: false,
      worktree: false,
      questions: false,
      pullRequest: false,
    },
    async list() {
      return [];
    },
    async start() {
      throw new Error("not used");
    },
    async send() {
      throw new Error("not used");
    },
    async wait() {
      throw new Error("not used");
    },
    async show() {
      throw new Error("not used");
    },
  };
}

test("uses the first backend as the default", () => {
  const registry = new CodingBackendRegistry([createBackend("first"), createBackend("second")]);

  assert.equal(registry.defaultId, "first");
  assert.equal(registry.get().id, "first");
  assert.equal(registry.get("second").id, "second");
});

test("rejects duplicate backend ids", () => {
  assert.throws(
    () => new CodingBackendRegistry([createBackend("same"), createBackend("same")]),
    /Duplicate coding backend id/,
  );
});

test("rejects an unknown default", () => {
  assert.throws(
    () => new CodingBackendRegistry([createBackend("known")], "missing"),
    /Unknown default coding backend/,
  );
});

test("resolves a session reference to its backend", () => {
  const registry = new CodingBackendRegistry([createBackend("first"), createBackend("second")]);

  assert.deepEqual(registry.resolve("session-1"), {
    backend: registry.get("first"),
    sessionId: "session-1",
  });
  assert.deepEqual(registry.resolve("second:session-1"), {
    backend: registry.get("second"),
    sessionId: "session-1",
  });
});

test("keeps colons in a session id when the prefix is not a backend", () => {
  const registry = new CodingBackendRegistry([createBackend("first")]);

  assert.deepEqual(registry.resolve("mcp:thread-1"), {
    backend: registry.get("first"),
    sessionId: "mcp:thread-1",
  });
});

test("names the available backends when an id is unknown", () => {
  const registry = new CodingBackendRegistry([createBackend("first"), createBackend("second")]);

  assert.throws(() => registry.get("missing"), /Unknown coding backend "missing".*first, second/);
});
