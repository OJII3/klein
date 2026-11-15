import assert from "node:assert/strict";
import test from "node:test";

import { assertSurfaceToolsAllowed, findSurfaceTool, resolveAgentPolicy } from "./agent-role";

test("conversation agents own the surface and live with the conversation", () => {
  assert.deepEqual(resolveAgentPolicy({ kind: "conversation" }), {
    surface: "owner",
    lifetime: "conversation",
    assistantText: "none",
  });
});

test("attached agents return results to the conversation agent", () => {
  assert.deepEqual(resolveAgentPolicy({ kind: "attached", taskId: "task-1" }), {
    surface: "none",
    lifetime: "task",
    assistantText: "caller",
  });
});

test("standalone agents return results to their caller", () => {
  assert.deepEqual(resolveAgentPolicy({ kind: "standalone" }), {
    surface: "none",
    lifetime: "call",
    assistantText: "caller",
  });
});

test("only conversation agents may hold a surface tool", () => {
  assert.doesNotThrow(() => assertSurfaceToolsAllowed({ kind: "conversation" }, ["discord_send"]));
  assert.throws(
    () => assertSurfaceToolsAllowed({ kind: "attached", taskId: "task-1" }, ["discord_send"]),
    /attached agent role may not use the surface tool discord_send/,
  );
  assert.throws(
    () => assertSurfaceToolsAllowed({ kind: "standalone" }, ["discord_speak"]),
    /standalone agent role may not use the surface tool discord_speak/,
  );
});

test("non-surface tools are allowed for every role", () => {
  assert.equal(findSurfaceTool({ kind: "standalone" }, ["read", "write"]), undefined);
});
