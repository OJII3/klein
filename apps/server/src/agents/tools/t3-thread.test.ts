import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import { isRecord } from "@shared/type-guards";
import {
  createT3ThreadTools,
  type T3ThreadRunner,
  type T3ThreadStartInput,
  type T3ThreadSendInput,
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
    async show(threadId, messages) {
      showInputs.push({ threadId, messages });
      return {
        thread: {
          id: threadId,
          title: "Fix the parser",
          status: "completed",
          link: "https://app.t3.codes/threads/example/mcp%3Athread-1",
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
    ["t3_thread_start", "t3_thread_send", "t3_thread_show", "t3_thread_list"],
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
      "https://app.t3.codes/threads/example/mcp%3Athread-1\n\n" +
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
  assert.equal(textOf(result), "- mcp:thread-1  completed  Fix the parser");
});
