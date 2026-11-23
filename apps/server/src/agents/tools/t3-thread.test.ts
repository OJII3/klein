import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import { isRecord } from "@shared/type-guards";
import {
  createT3ThreadTools,
  type T3ThreadRunner,
  type T3ThreadStartInput,
  type T3ThreadSendInput,
  type T3ThreadWaitInput,
} from "./t3-thread";

function createStubRunner() {
  const startInputs: T3ThreadStartInput[] = [];
  const sendInputs: T3ThreadSendInput[] = [];
  const listProjects: (string | undefined)[] = [];
  const showInputs: { threadId: string; messages: number }[] = [];

  const runner: T3ThreadRunner = {
    async list(project) {
      listProjects.push(project);
      return [
        {
          id: "mcp:thread-1",
          title: "Fix the parser",
          status: "completed",
          link: "https://app.t3.codes/threads/example/mcp%3Athread-1",
          branch: "feat/parser",
          worktreePath: "/tmp/klein-worktree",
          pendingRequestCount: 2,
          pullRequestCount: 2,
          openPullRequestCount: 1,
          linkedPullRequest: {
            repository: "OJII3/klein",
            number: 12,
            url: "https://github.com/OJII3/klein/pull/12",
          },
        },
      ];
    },
    async start(input) {
      startInputs.push(input);
      return { threadId: "mcp:thread-1", status: "completed", reply: "Fixed it." };
    },
    async send(input) {
      sendInputs.push(input);
      return { threadId: input.threadId, status: "completed", reply: "Also updated the tests." };
    },
    async wait(input) {
      return {
        thread: {
          id: input.threadId,
          title: "Fix the parser",
          status: "completed",
        },
        messages: [{ role: "assistant", text: "ok" }],
        timedOut: false,
      };
    },
    async show(threadId, messages) {
      showInputs.push({ threadId, messages });
      return {
        thread: {
          id: threadId,
          title: "Fix the parser",
          status: "completed",
          link: "https://app.t3.codes/threads/example/mcp%3Athread-1",
          branch: "feat/parser",
          worktreePath: "/tmp/klein-worktree",
          pendingRequestCount: 2,
          pullRequestCount: 2,
          openPullRequestCount: 1,
          linkedPullRequest: {
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

  return { runner, startInputs, sendInputs, listProjects, showInputs };
}

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0];
  return isRecord(block) && block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

test("registers the T3 thread tools", () => {
  const { runner } = createStubRunner();
  const tools = createT3ThreadTools(runner);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["t3_thread_start", "t3_thread_send", "t3_thread_wait", "t3_thread_show", "t3_thread_list"],
  );
});

test("starts a T3 thread with wait enabled by default", async () => {
  const { runner, startInputs } = createStubRunner();
  const tool = createT3ThreadTools(runner).find(
    (candidate) => candidate.name === "t3_thread_start",
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
  assert.equal(textOf(result), "Started T3 thread mcp:thread-1 (completed).\n\nFixed it.");
});

test("returns as soon as the thread starts when wait is false", async () => {
  const { runner, startInputs } = createStubRunner();
  runner.start = async (input) => {
    startInputs.push(input);
    return { threadId: "mcp:thread-2", status: "running" };
  };
  const tool = createT3ThreadTools(runner).find(
    (candidate) => candidate.name === "t3_thread_start",
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
  assert.match(textOf(result), /still running; use t3_thread_show/);
});

test("tells the worker to answer a thread that is waiting", async () => {
  const { runner } = createStubRunner();
  runner.send = async (input) => ({ threadId: input.threadId, status: "waiting" });
  const tool = createT3ThreadTools(runner).find((candidate) => candidate.name === "t3_thread_send");
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { threadId: "mcp:thread-1", message: "Continue." },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.match(textOf(result), /waiting for an answer/);
  assert.match(textOf(result), /t3_thread_send/);
  assert.doesNotMatch(textOf(result), /still running/);
});

test("does not report a cancelled run as still running", async () => {
  const { runner } = createStubRunner();
  runner.send = async (input) => ({ threadId: input.threadId, status: "cancelled" });
  const tool = createT3ThreadTools(runner).find((candidate) => candidate.name === "t3_thread_send");
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { threadId: "mcp:thread-1", message: "Continue." },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.doesNotMatch(textOf(result), /still running/);
});

test("rejects a branch name without a worktree base", async () => {
  const { runner, startInputs } = createStubRunner();
  const tool = createT3ThreadTools(runner).find(
    (candidate) => candidate.name === "t3_thread_start",
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

test("sends a follow-up and returns the reply", async () => {
  const { runner, sendInputs } = createStubRunner();
  const tool = createT3ThreadTools(runner).find((candidate) => candidate.name === "t3_thread_send");
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { threadId: "mcp:thread-1", message: "Update the tests too." },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(sendInputs, [
    { threadId: "mcp:thread-1", message: "Update the tests too.", wait: true },
  ]);
  assert.match(textOf(result), /Also updated the tests\./);
});

test("waits for a thread with a default timeout and returns its messages", async () => {
  const { runner } = createStubRunner();
  const waitInputs: T3ThreadWaitInput[] = [];
  runner.wait = async (input) => {
    waitInputs.push(input);
    return {
      thread: { id: input.threadId, title: "Fix the parser", status: "completed" },
      messages: [{ role: "assistant", text: "Fixed it." }],
      timedOut: false,
    };
  };
  const tool = createT3ThreadTools(runner).find((candidate) => candidate.name === "t3_thread_wait");
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { threadId: "mcp:thread-1" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(waitInputs, [{ threadId: "mcp:thread-1", messages: 10, timeoutMs: 300_000 }]);
  assert.match(textOf(result), /finished \(completed\)/);
  assert.match(textOf(result), /Fixed it\./);
});

test("returns the current state when waiting times out", async () => {
  const { runner } = createStubRunner();
  const waitInputs: T3ThreadWaitInput[] = [];
  runner.wait = async (input) => {
    waitInputs.push(input);
    return {
      thread: { id: input.threadId, title: "Fix the parser", status: "running" },
      messages: [{ role: "assistant", text: "Still working." }],
      timedOut: true,
    };
  };
  const tool = createT3ThreadTools(runner).find((candidate) => candidate.name === "t3_thread_wait");
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { threadId: "mcp:thread-1", timeoutSeconds: 5, messages: 2 },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(waitInputs, [{ threadId: "mcp:thread-1", messages: 2, timeoutMs: 5_000 }]);
  assert.match(textOf(result), /still running after 5s/);
  assert.match(textOf(result), /t3_thread_wait again/);
});

test("reports a waiting thread as asking for an answer", async () => {
  const { runner } = createStubRunner();
  runner.wait = async (input) => ({
    thread: {
      id: input.threadId,
      title: "Fix the parser",
      status: "waiting",
      pendingRequestCount: 1,
    },
    messages: [{ role: "assistant", text: "Which branch?" }],
    timedOut: false,
  });
  const tool = createT3ThreadTools(runner).find((candidate) => candidate.name === "t3_thread_wait");
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { threadId: "mcp:thread-1" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.match(textOf(result), /waiting for an answer/);
  assert.match(textOf(result), /Which branch\?/);
});

test("shows the thread link and latest messages", async () => {
  const { runner, showInputs } = createStubRunner();
  const tool = createT3ThreadTools(runner).find((candidate) => candidate.name === "t3_thread_show");
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    { threadId: "mcp:thread-1" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(showInputs, [{ threadId: "mcp:thread-1", messages: 10 }]);
  assert.equal(
    textOf(result),
    "Fix the parser — mcp:thread-1 (completed)\n" +
      "https://app.t3.codes/threads/example/mcp%3Athread-1\n" +
      "branch: feat/parser (worktree /tmp/klein-worktree)\n" +
      "Waiting for 2 answer(s).\n" +
      "PR: https://github.com/OJII3/klein/pull/12\n\n" +
      "[user]\nFix the parser.\n\n" +
      "[assistant]\nFixed it.",
  );
});

test("lists threads and defaults the project to the runner", async () => {
  const { runner, listProjects } = createStubRunner();
  const tool = createT3ThreadTools(runner).find((candidate) => candidate.name === "t3_thread_list");
  assert.ok(tool);

  const result = await tool.execute(
    "tool-call",
    {},
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(listProjects, [undefined]);
  assert.equal(textOf(result), "- mcp:thread-1  completed  Fix the parser  [waiting 2, 1 open PR]");
});
