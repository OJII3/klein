import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ToolAuthorization } from "./tool-permissions";

test("owner access is determined by session permissions", () => {
  for (const session of [false, true]) {
    const auth = new ToolAuthorization(session, {
      tools: { overrides: { private_tool: "owner", disabled: "deny" } },
      mcp: { servers: { blocked: "deny" } },
    });
    assert.equal(auth.allowsTool("private_tool"), session);
    assert.equal(auth.allowsTool("mcp__obsidian__read_note"), session);
    assert.equal(auth.allowsTool("disabled"), false);
    assert.equal(auth.allowsTool("mcp__blocked__read_note"), false);
    assert.equal(auth.allowsTool("public_tool"), true);
  }
});

test("MCP resource calls check session permissions for exact servers and listings", () => {
  for (const session of [false, true]) {
    const auth = new ToolAuthorization(session, {
      mcp: { servers: { docs: "allow", blocked: "deny" } },
    });
    auth.rememberServers(["docs", "obsidian", "blocked"]);
    assert.equal(auth.allowsResource({ server: "docs" }), true);
    assert.equal(auth.allowsResource({ server: "obsidian" }), session);
    assert.equal(auth.allowsResource({ server: "blocked" }), false);
    assert.equal(auth.allowsResource({}), true);
  }
});

test("registered MCP tools use namespace authorization despite truncation and name collisions", () => {
  const auth = new ToolAuthorization(false, { mcp: { servers: { "private-vault": "allow" } } });
  auth.rememberServers(["private-vault", "private_vault"]);
  let definition: ToolDefinition | undefined;
  const pi = {
    registerTool: (tool: ToolDefinition) => {
      definition = tool;
    },
  } as ExtensionAPI;
  auth.wrap((api) =>
    api.registerTool({
      name: "mcp__private_vault__truncated_1234",
      namespace: { name: "mcp__private_vault" },
      label: "Note",
      description: "Note",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    }),
  )(pi);
  assert.equal(definition?.exposure, "hidden");
  assert.equal(auth.allowsTool("mcp__private_vault__truncated_1234"), false);
});

test("public MCP resource listings exclude servers the session cannot connect to", () => {
  const auth = new ToolAuthorization(false, { mcp: { servers: { docs: "allow" } } });
  auth.rememberServers(["docs", "obsidian"]);
  assert.equal(auth.allowsResource({}), true);
  assert.equal(auth.allowsResource({ server: "docs" }), true);
  assert.equal(auth.allowsResource({ server: "obsidian" }), false);
});
