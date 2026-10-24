import assert from "node:assert/strict";
import test from "node:test";
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

test("public MCP resource listings exclude servers the session cannot connect to", () => {
  const auth = new ToolAuthorization(false, { mcp: { servers: { docs: "allow" } } });
  auth.rememberServers(["docs", "obsidian"]);
  assert.equal(auth.allowsResource({}), true);
  assert.equal(auth.allowsResource({ server: "docs" }), true);
  assert.equal(auth.allowsResource({ server: "obsidian" }), false);
});
