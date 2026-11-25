import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import { CodingBackendRegistry } from "@modules/coding/application/coding-backend-registry";
import type { CodingBackend } from "@modules/coding/ports/coding-backend";
import type {
  CodingSessionSendInput,
  CodingSessionStartInput,
  CodingSessionWaitInput,
} from "@modules/coding/domain/coding-session";
import { isRecord } from "@shared/type-guards";
import { createCodingSessionTools } from "./coding-session";

function createStubRegistry() {
  const startInputs: CodingSessionStartInput[] = [];
  const sendInputs: CodingSessionSendInput[] = [];
  const listedProjects: (string | undefined)[] = [];
  const showInputs: { sessionId: string; messages: number }[] = [];

  const backend: CodingBackend = {
    id: "stub",
    label: "Stub",
    capabilities: {
      worktree: true,
    },
    async list(project) {
      listedProjects.push(project);
      return [
        {
          id: "session-1",
          title: "Fix the parser",
          status: "completed",
          link: "https://example.test/sessions/session-1",
          branch: "feat/parser",
          worktreePath: "/tmp/klein-worktree",
          pendingQuestionCount: 2,
          pullRequestCount: 2,
          openPullRequestCount: 1,
          pullRequest: {
            repository: "OJII3/klein",
            number: 12,
            url: "https://github.com/OJII3/klein/pull/12",
          },
        },
      ];
    },
    async start(input) {
      startInputs.push(input);
      return { sessionId: "session-1", status: "completed", reply: "Fixed it." };
    },
    async send(input) {
      sendInputs.push(input);
      return { sessionId: input.sessionId, status: "completed", reply: "Also updated the tests." };
    },
    async wait(input) {
      return {
        session: { id: input.sessionId, title: "Fix the parser", status: "completed" },
        messages: [{ role: "assistant", text: "ok" }],
        timedOut: false,
      };
    },
    async show(sessionId, messages) {
      showInputs.push({ sessionId, messages });
      return {
        session: {
          id: sessionId,
          title: "Fix the parser",
          status: "completed",
          link: "https://example.test/sessions/session-1",
          branch: "feat/parser",
          worktreePath: "/tmp/klein-worktree",
          pendingQuestionCount: 2,
          pullRequestCount: 2,
          openPullRequestCount: 1,
          pullRequest: {
            repository: "OJII3/klein",
            number: 12,
            url: "https://github.com/OJII3/klein/pull/12",
          },
        },
        messages: [
          { role: "user", text: "Fix the parser." },
          { role: "assistant", text: "Fixed it." },
        ],
      };
    },
  };

  return {
    registry: new CodingBackendRegistry([backend]),
    backend,
    startInputs,
    sendInputs,
    listedProjects,
    showInputs,
  };
}

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0];
  return isRecord(block) && block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

test("registers the coding session tools", () => {
  const { registry } = createStubRegistry();
  const tools = createCodingSessionTools(registry);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "coding_session_start",
      "coding_session_send",
      "coding_session_wait",
      "coding_session_show",
      "coding_session_list",
    ],
  );
});

test("starts a coding session with wait enabled by default", async () => {
  const { registry, startInputs } = createStubRegistry();
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_start",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { message: "Fix the parser.", title: "Parser", project: "klein", wait: undefined },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(startInputs, [
    {
      project: "klein",
      message: "Fix the parser.",
      title: "Parser",
      wait: true,
    },
  ]);
  assert.equal(textOf(result), "Started coding session stub:session-1 (completed).\n\nFixed it.");
});

test("returns as soon as the session starts when wait is false", async () => {
  const { registry, startInputs, backend } = createStubRegistry();
  backend.start = async (input) => {
    startInputs.push(input);
    return { sessionId: "session-2", status: "running" };
  };
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_start",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { message: "Fix the parser.", wait: false },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.equal(startInputs[0]?.wait, false);
  assert.match(textOf(result), /still running; use coding_session_show/);
});

test("tells the worker to answer a session that is waiting", async () => {
  const { registry, backend } = createStubRegistry();
  backend.send = async (input) => ({ sessionId: input.sessionId, status: "waiting" });
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_send",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { session: "stub:session-1", message: "Continue." },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.match(textOf(result), /waiting for an answer/);
  assert.match(textOf(result), /coding_session_send/);
  assert.doesNotMatch(textOf(result), /still running/);
});

test("does not report a cancelled run as still running", async () => {
  const { registry, backend } = createStubRegistry();
  backend.send = async (input) => ({ sessionId: input.sessionId, status: "cancelled" });
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_send",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { session: "stub:session-1", message: "Continue." },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.doesNotMatch(textOf(result), /still running/);
});

test("rejects a branch name without a worktree base", async () => {
  const { registry, startInputs } = createStubRegistry();
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_start",
  );
  assert.ok(tool);

  await assert.rejects(
    tool.execute(
      "tool-call",
      { message: "Fix the parser.", branch: "feat/parser" },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    ),
    /`branch` needs `worktree`/,
  );
  assert.deepEqual(startInputs, []);
});

test("rejects worktree options on a backend without worktree support", async () => {
  const { backend, startInputs } = createStubRegistry();
  const restricted = new CodingBackendRegistry([
    {
      ...backend,
      capabilities: {
        worktree: false,
      },
    },
  ]);
  const tool = createCodingSessionTools(restricted).find(
    (candidate) => candidate.name === "coding_session_start",
  );
  assert.ok(tool);

  await assert.rejects(
    tool.execute(
      "tool-call",
      { message: "Fix the parser.", worktree: "main", branch: "feat/parser" },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    ),
    /does not support worktrees/,
  );
  assert.deepEqual(startInputs, []);
});

test("sends a follow-up and returns the reply", async () => {
  const { registry, sendInputs } = createStubRegistry();
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_send",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { session: "stub:session-1", message: "Update the tests too." },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(sendInputs, [
    { sessionId: "session-1", message: "Update the tests too.", wait: true },
  ]);
  assert.match(textOf(result), /Also updated the tests\./);
});

test("waits for a session with a default timeout and returns its messages", async () => {
  const { registry, backend } = createStubRegistry();
  const waitInputs: CodingSessionWaitInput[] = [];
  backend.wait = async (input) => {
    waitInputs.push(input);
    return {
      session: { id: input.sessionId, title: "Fix the parser", status: "completed" },
      messages: [{ role: "assistant", text: "Fixed it." }],
      timedOut: false,
    };
  };
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_wait",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { session: "stub:session-1" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(waitInputs, [{ sessionId: "session-1", messages: 10, timeoutMs: 300_000 }]);
  assert.match(textOf(result), /finished \(completed\)/);
  assert.match(textOf(result), /Fixed it\./);
});

test("returns the current state when waiting times out", async () => {
  const { registry, backend } = createStubRegistry();
  const waitInputs: CodingSessionWaitInput[] = [];
  backend.wait = async (input) => {
    waitInputs.push(input);
    return {
      session: { id: input.sessionId, title: "Fix the parser", status: "running" },
      messages: [{ role: "assistant", text: "Still working." }],
      timedOut: true,
    };
  };
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_wait",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { session: "stub:session-1", timeoutSeconds: 5, messages: 2 },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(waitInputs, [{ sessionId: "session-1", messages: 2, timeoutMs: 5_000 }]);
  assert.match(textOf(result), /still running after 5s/);
  assert.match(textOf(result), /coding_session_wait again/);
});

test("reports a waiting session as asking for an answer", async () => {
  const { registry, backend } = createStubRegistry();
  backend.wait = async (input) => ({
    session: {
      id: input.sessionId,
      title: "Fix the parser",
      status: "waiting",
      pendingQuestionCount: 1,
    },
    messages: [{ role: "assistant", text: "Which branch?" }],
    timedOut: false,
  });
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_wait",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { session: "stub:session-1" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.match(textOf(result), /waiting for an answer/);
  assert.match(textOf(result), /Which branch\?/);
});

test("shows the session link and latest messages", async () => {
  const { registry, showInputs } = createStubRegistry();
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_show",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { session: "stub:session-1" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(showInputs, [{ sessionId: "session-1", messages: 10 }]);
  assert.equal(
    textOf(result),
    "Fix the parser — stub:session-1 (completed)\n" +
      "https://example.test/sessions/session-1\n" +
      "branch: feat/parser (worktree /tmp/klein-worktree)\n" +
      "Waiting for 2 answer(s).\n" +
      "PR: https://github.com/OJII3/klein/pull/12\n\n" +
      "[user]\nFix the parser.\n\n" +
      "[assistant]\nFixed it.",
  );
});

test("lists sessions and defaults the project to the backend", async () => {
  const { registry, listedProjects } = createStubRegistry();
  const tool = createCodingSessionTools(registry).find(
    (candidate) => candidate.name === "coding_session_list",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    {},
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(listedProjects, [undefined]);
  assert.equal(
    textOf(result),
    "- stub:session-1  completed  Fix the parser  [waiting 2, 1 open PR]",
  );
});
