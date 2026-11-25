import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import { CodingBackendRegistry } from "@modules/coding/application/coding-backend-registry";
import type { CodingBackend } from "@modules/coding/ports/coding-backend";
import { isRecord } from "@shared/type-guards";
import { createCodingProjectListTool } from "./coding-project";

function createBackend(overrides: Partial<CodingBackend> = {}): CodingBackend {
  return {
    id: "stub",
    label: "Stub",
    capabilities: {
      projects: true,
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
    ...overrides,
  };
}

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0];
  return isRecord(block) && block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

test("lists coding projects with their workspace paths and ids", async () => {
  const tool = createCodingProjectListTool(
    new CodingBackendRegistry([
      createBackend({
        async listProjects() {
          return [
            { id: "project-1", title: "klein", workspaceRoot: "/work/klein" },
            { id: "project-2", title: "dotfiles", workspaceRoot: "/work/dotfiles" },
          ];
        },
      }),
    ]),
  );

  const result = await tool.execute(
    "tool-call",
    {},
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.equal(
    textOf(result),
    "- klein  /work/klein  (project-1)\n- dotfiles  /work/dotfiles  (project-2)",
  );
});

test("reports when no projects are registered", async () => {
  const tool = createCodingProjectListTool(
    new CodingBackendRegistry([
      createBackend({
        async listProjects() {
          return [];
        },
      }),
    ]),
  );

  const result = await tool.execute(
    "tool-call",
    {},
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.equal(textOf(result), "No Stub projects.");
});

test("tells the worker to pass a path when the backend cannot list projects", async () => {
  const tool = createCodingProjectListTool(
    new CodingBackendRegistry([
      createBackend({
        capabilities: {
          projects: false,
          worktree: false,
          questions: false,
          pullRequest: false,
        },
      }),
    ]),
  );

  const result = await tool.execute(
    "tool-call",
    {},
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.match(textOf(result), /does not list projects/);
  assert.match(textOf(result), /Pass a repository path/);
});
