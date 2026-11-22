import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import { isRecord } from "@shared/type-guards";
import { createT3ProjectListTool, type T3ProjectLister } from "./t3-project";

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0];
  return isRecord(block) && block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

test("lists T3 projects with their workspace paths and ids", async () => {
  const lister: T3ProjectLister = {
    async list() {
      return [
        { id: "project-1", title: "klein", workspaceRoot: "/work/klein" },
        { id: "project-2", title: "dotfiles", workspaceRoot: "/work/dotfiles" },
      ];
    },
  };
  const tool = createT3ProjectListTool(lister);

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

test("reports when no T3 projects are registered", async () => {
  const tool = createT3ProjectListTool({
    async list() {
      return [];
    },
  });

  const result = await tool.execute(
    "tool-call",
    {},
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.equal(textOf(result), "No T3 Code projects.");
});
