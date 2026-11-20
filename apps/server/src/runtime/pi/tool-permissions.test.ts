import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { createStubExtensionApi, type RegisteredToolSummary } from "./pi-test-helpers";
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

test("built-in servers bypass the owner-only MCP default but not an explicit denial", () => {
  const auth = new ToolAuthorization(false, {
    mcp: { servers: { agent_browser: "allow", blocked: "deny" } },
  });
  auth.allowBuiltinServers(["agent_browser", "blocked"]);

  assert.equal(auth.allowsServer("agent_browser"), true);
  assert.equal(auth.allowsServer("blocked"), false);

  const defaultDenied = new ToolAuthorization(false, { mcp: { default: "deny" } });
  defaultDenied.allowBuiltinServers(["agent_browser"]);
  assert.equal(defaultDenied.allowsServer("agent_browser"), true);
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

test("registered MCP tools use namespace authorization despite truncation and name collisions", async () => {
  const auth = new ToolAuthorization(false, { mcp: { servers: { "private-vault": "allow" } } });
  auth.rememberServers(["private-vault", "private_vault"]);
  let definition: RegisteredToolSummary | undefined;
  const pi = createStubExtensionApi({
    onRegisterTool: (tool) => {
      definition = tool;
    },
  });
  await auth.wrap((api) =>
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
