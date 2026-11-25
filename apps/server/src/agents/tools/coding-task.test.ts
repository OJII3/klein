import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import { CodingBackendRegistry } from "@modules/coding/application/coding-backend-registry";
import type { CodingBackend } from "@modules/coding/ports/coding-backend";
import type {
  CodingTaskSendInput,
  CodingTaskStartInput,
  CodingTaskWaitInput,
} from "@modules/coding/domain/coding-task";
import { isRecord } from "@shared/type-guards";
import { createCodingTaskTools } from "./coding-task";

function createStubRegistry() {
  const startInputs: CodingTaskStartInput[] = [];
  const sendInputs: CodingTaskSendInput[] = [];
  const listProjects: (string | undefined)[] = [];
  const showInputs: { taskId: string; messages: number }[] = [];

  const backend: CodingBackend = {
    id: "stub",
    label: "Stub",
    capabilities: {
      projects: true,
      worktree: true,
      questions: true,
      pullRequest: true,
    },
    async listProjects() {
      return [];
    },
    async list(project) {
      listProjects.push(project);
      return [
        {
          id: "task-1",
          title: "Fix the parser",
          status: "completed",
          link: "https://example.test/tasks/task-1",
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
      return { taskId: "task-1", status: "completed", reply: "Fixed it." };
    },
    async send(input) {
      sendInputs.push(input);
      return { taskId: input.taskId, status: "completed", reply: "Also updated the tests." };
    },
    async wait(input) {
      return {
        task: { id: input.taskId, title: "Fix the parser", status: "completed" },
        messages: [{ role: "assistant", text: "ok" }],
        timedOut: false,
      };
    },
    async show(taskId, messages) {
      showInputs.push({ taskId, messages });
      return {
        task: {
          id: taskId,
          title: "Fix the parser",
          status: "completed",
          link: "https://example.test/tasks/task-1",
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
    listProjects,
    showInputs,
  };
}

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0];
  return isRecord(block) && block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

test("registers the coding task tools", () => {
  const { registry } = createStubRegistry();
  const tools = createCodingTaskTools(registry);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "coding_backend_list",
      "coding_task_start",
      "coding_task_send",
      "coding_task_wait",
      "coding_task_show",
      "coding_task_list",
    ],
  );
});

test("lists backends and their capabilities", async () => {
  const { registry } = createStubRegistry();
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_backend_list",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    {},
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.equal(
    textOf(result),
    "- stub: Stub (projects, worktrees, pull requests, questions) — default",
  );
});

test("starts a coding task with wait enabled by default", async () => {
  const { registry, startInputs } = createStubRegistry();
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_start",
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
  assert.equal(textOf(result), "Started coding task stub:task-1 (completed).\n\nFixed it.");
});

test("returns as soon as the task starts when wait is false", async () => {
  const { registry, startInputs, backend } = createStubRegistry();
  backend.start = async (input) => {
    startInputs.push(input);
    return { taskId: "task-2", status: "running" };
  };
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_start",
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
  assert.match(textOf(result), /still running; use coding_task_show/);
});

test("tells the worker to answer a task that is waiting", async () => {
  const { registry, backend } = createStubRegistry();
  backend.send = async (input) => ({ taskId: input.taskId, status: "waiting" });
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_send",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { task: "stub:task-1", message: "Continue." },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.match(textOf(result), /waiting for an answer/);
  assert.match(textOf(result), /coding_task_send/);
  assert.doesNotMatch(textOf(result), /still running/);
});

test("does not report a cancelled run as still running", async () => {
  const { registry, backend } = createStubRegistry();
  backend.send = async (input) => ({ taskId: input.taskId, status: "cancelled" });
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_send",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { task: "stub:task-1", message: "Continue." },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.doesNotMatch(textOf(result), /still running/);
});

test("rejects a branch name without a worktree base", async () => {
  const { registry, startInputs } = createStubRegistry();
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_start",
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
        projects: true,
        worktree: false,
        questions: true,
        pullRequest: true,
      },
    },
  ]);
  const tool = createCodingTaskTools(restricted).find(
    (candidate) => candidate.name === "coding_task_start",
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
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_send",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { task: "stub:task-1", message: "Update the tests too." },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(sendInputs, [
    { taskId: "task-1", message: "Update the tests too.", wait: true },
  ]);
  assert.match(textOf(result), /Also updated the tests\./);
});

test("waits for a task with a default timeout and returns its messages", async () => {
  const { registry, backend } = createStubRegistry();
  const waitInputs: CodingTaskWaitInput[] = [];
  backend.wait = async (input) => {
    waitInputs.push(input);
    return {
      task: { id: input.taskId, title: "Fix the parser", status: "completed" },
      messages: [{ role: "assistant", text: "Fixed it." }],
      timedOut: false,
    };
  };
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_wait",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { task: "stub:task-1" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(waitInputs, [{ taskId: "task-1", messages: 10, timeoutMs: 300_000 }]);
  assert.match(textOf(result), /finished \(completed\)/);
  assert.match(textOf(result), /Fixed it\./);
});

test("returns the current state when waiting times out", async () => {
  const { registry, backend } = createStubRegistry();
  const waitInputs: CodingTaskWaitInput[] = [];
  backend.wait = async (input) => {
    waitInputs.push(input);
    return {
      task: { id: input.taskId, title: "Fix the parser", status: "running" },
      messages: [{ role: "assistant", text: "Still working." }],
      timedOut: true,
    };
  };
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_wait",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { task: "stub:task-1", timeoutSeconds: 5, messages: 2 },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(waitInputs, [{ taskId: "task-1", messages: 2, timeoutMs: 5_000 }]);
  assert.match(textOf(result), /still running after 5s/);
  assert.match(textOf(result), /coding_task_wait again/);
});

test("reports a waiting task as asking for an answer", async () => {
  const { registry, backend } = createStubRegistry();
  backend.wait = async (input) => ({
    task: {
      id: input.taskId,
      title: "Fix the parser",
      status: "waiting",
      pendingQuestionCount: 1,
    },
    messages: [{ role: "assistant", text: "Which branch?" }],
    timedOut: false,
  });
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_wait",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { task: "stub:task-1" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.match(textOf(result), /waiting for an answer/);
  assert.match(textOf(result), /Which branch\?/);
});

test("shows the task link and latest messages", async () => {
  const { registry, showInputs } = createStubRegistry();
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_show",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { task: "stub:task-1" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(showInputs, [{ taskId: "task-1", messages: 10 }]);
  assert.equal(
    textOf(result),
    "Fix the parser — stub:task-1 (completed)\n" +
      "https://example.test/tasks/task-1\n" +
      "branch: feat/parser (worktree /tmp/klein-worktree)\n" +
      "Waiting for 2 answer(s).\n" +
      "PR: https://github.com/OJII3/klein/pull/12\n\n" +
      "[user]\nFix the parser.\n\n" +
      "[assistant]\nFixed it.",
  );
});

test("lists tasks and defaults the project to the backend", async () => {
  const { registry, listProjects } = createStubRegistry();
  const tool = createCodingTaskTools(registry).find(
    (candidate) => candidate.name === "coding_task_list",
  );
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    {},
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(listProjects, [undefined]);
  assert.equal(textOf(result), "- stub:task-1  completed  Fix the parser  [waiting 2, 1 open PR]");
});
