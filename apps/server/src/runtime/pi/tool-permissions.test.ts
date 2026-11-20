import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { createStubExtensionApi, type RegisteredToolSummary } from "./pi-test-helpers";
import { ToolAuthorization } from "./tool-permissions";

test("permission levels distinguish public, linked-user, and owner sessions", () => {
  const permissions = {
    tools: { overrides: { user_tool: "user", owner_tool: "owner", disabled: "deny" } },
    mcp: { servers: { user_server: "user", blocked: "deny" } },
  } as const;

  for (const [session, userAllowed, ownerAllowed] of [
    ["public", false, false],
    ["user", true, false],
    ["owner", true, true],
  ] as const) {
    const auth = new ToolAuthorization(session, permissions);
    assert.equal(auth.allowsTool("user_tool"), userAllowed);
    assert.equal(auth.allowsServer("user_server"), userAllowed);
    assert.equal(auth.allowsTool("owner_tool"), ownerAllowed);
    assert.equal(auth.allowsTool("mcp__obsidian__read_note"), ownerAllowed);
    assert.equal(auth.allowsTool("mcp__blocked__read_note"), false);
    assert.equal(auth.allowsTool("disabled"), false);
    assert.equal(auth.allowsTool("public_tool"), true);
  }
});

test("built-in servers default to a permission level and an explicit override wins", () => {
  const builtin = { agent_browser: "user" } as const;

  assert.equal(
    new ToolAuthorization("user", {}, undefined, builtin).allowsServer("agent_browser"),
    true,
  );
  assert.equal(
    new ToolAuthorization("public", {}, undefined, builtin).allowsServer("agent_browser"),
    false,
  );
  assert.equal(
    new ToolAuthorization(
      "owner",
      { mcp: { servers: { agent_browser: "deny" } } },
      undefined,
      builtin,
    ).allowsServer("agent_browser"),
    false,
  );
});

test("MCP resource calls check session permissions for exact servers and listings", () => {
  for (const [session, ownerAllowed] of [
    ["public", false],
    ["user", false],
    ["owner", true],
  ] as const) {
    const auth = new ToolAuthorization(session, {
      mcp: { servers: { docs: "allow", blocked: "deny" } },
    });
    auth.rememberServers(["docs", "obsidian", "blocked"]);
    assert.equal(auth.allowsResource({ server: "docs" }), true);
    assert.equal(auth.allowsResource({ server: "obsidian" }), ownerAllowed);
    assert.equal(auth.allowsResource({ server: "blocked" }), false);
    assert.equal(auth.allowsResource({}), true);
  }
});

test("registered MCP tools use namespace authorization despite truncation and name collisions", async () => {
  const auth = new ToolAuthorization("public", { mcp: { servers: { "private-vault": "allow" } } });
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
  const auth = new ToolAuthorization("public", { mcp: { servers: { docs: "allow" } } });
  auth.rememberServers(["docs", "obsidian"]);
  assert.equal(auth.allowsResource({}), true);
  assert.equal(auth.allowsResource({ server: "docs" }), true);
  assert.equal(auth.allowsResource({ server: "obsidian" }), false);
});
