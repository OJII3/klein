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
  assert.doesNotThrow(() =>
    assertSurfaceToolsAllowed({ kind: "conversation" }, [{ name: "discord_send", surface: true }]),
  );
  assert.doesNotThrow(() =>
    assertSurfaceToolsAllowed({ kind: "conversation" }, [{ name: "discord_ask", surface: true }]),
  );
  assert.throws(
    () =>
      assertSurfaceToolsAllowed({ kind: "attached", taskId: "task-1" }, [
        { name: "discord_send", surface: true },
      ]),
    /attached agent role may not use the surface tool discord_send/,
  );
  assert.throws(
    () =>
      assertSurfaceToolsAllowed({ kind: "attached", taskId: "task-1" }, [
        { name: "discord_ask", surface: true },
      ]),
    /attached agent role may not use the surface tool discord_ask/,
  );
  assert.throws(
    () =>
      assertSurfaceToolsAllowed({ kind: "standalone" }, [{ name: "discord_speak", surface: true }]),
    /standalone agent role may not use the surface tool discord_speak/,
  );
});

test("non-surface tools are allowed for every role", () => {
  assert.equal(
    findSurfaceTool({ kind: "standalone" }, [{ name: "read" }, { name: "write" }]),
    undefined,
  );
});

test("a tool is a surface tool only when it declares itself", () => {
  assert.equal(findSurfaceTool({ kind: "standalone" }, [{ name: "discord_send" }]), undefined);
});
