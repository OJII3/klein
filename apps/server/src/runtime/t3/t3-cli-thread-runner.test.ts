import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createT3CliThreadRunner } from "./t3-cli-thread-runner";

const FAKE_T3 = `#!/bin/sh
printf '%s\\n' "$@" > "$0.args"
case "$1 $2" in
  "thread start")
    printf '%s\\n' '{"threadId":"mcp:thread-1","runId":"run-1","status":"completed","reply":"ok","error":null}'
    ;;
  "thread send")
    printf '%s\\n' '{"threadId":"mcp:thread-1","status":"waiting","reply":null,"error":null}'
    exit 2
    ;;
  "thread list")
    printf '%s\\n' '[{"threadId":"mcp:thread-1","title":"Fix the parser","status":"completed","link":"https://example.test/thread-1"}]'
    ;;
  "thread show")
    printf '%s\\n' '{"thread":{"threadId":"mcp:thread-1","title":"Fix the parser","status":"completed"},"messages":[{"role":"assistant","text":"ok"}]}'
    ;;
  *)
    echo "unexpected command: $1 $2" >&2
    exit 1
    ;;
esac
`;

async function createFakeT3(): Promise<{ command: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "t3-cli-runner-"));
  const command = join(directory, "t3");
  await writeFile(command, FAKE_T3);
  await chmod(command, 0o755);
  return { command, directory };
}

async function readArgs(command: string): Promise<string[]> {
  return (await readFile(`${command}.args`, "utf8")).trimEnd().split("\n");
}

test("starts a thread and parses the JSON reply", async (t) => {
  const { command, directory } = await createFakeT3();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runner = createT3CliThreadRunner({ command });

  const result = await runner.start({
    project: "klein",
    message: "Fix the parser.",
    title: "Parser",
    wait: true,
  });

  assert.deepEqual(result, {
    threadId: "mcp:thread-1",
    status: "completed",
    reply: "ok",
  });
  assert.deepEqual(await readArgs(command), [
    "thread",
    "start",
    "--json",
    "--wait",
    "--title",
    "Parser",
    "klein",
    "Fix the parser.",
  ]);
});

test("returns a waiting run without treating exit code 2 as a failure", async (t) => {
  const { command, directory } = await createFakeT3();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runner = createT3CliThreadRunner({ command });

  const result = await runner.send({
    threadId: "mcp:thread-1",
    message: "Continue.",
    wait: true,
  });

  assert.deepEqual(result, { threadId: "mcp:thread-1", status: "waiting" });
  assert.deepEqual(await readArgs(command), [
    "thread",
    "send",
    "--json",
    "--wait",
    "mcp:thread-1",
    "Continue.",
  ]);
});

test("lists threads from the project", async (t) => {
  const { command, directory } = await createFakeT3();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runner = createT3CliThreadRunner({ command });

  const threads = await runner.list("klein");

  assert.deepEqual(threads, [
    {
      id: "mcp:thread-1",
      title: "Fix the parser",
      status: "completed",
      link: "https://example.test/thread-1",
    },
  ]);
  assert.deepEqual(await readArgs(command), ["thread", "list", "--json", "--project", "klein"]);
});

test("shows a thread and its messages", async (t) => {
  const { command, directory } = await createFakeT3();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runner = createT3CliThreadRunner({ command });

  const detail = await runner.show("mcp:thread-1", 5);

  assert.deepEqual(detail, {
    thread: { id: "mcp:thread-1", title: "Fix the parser", status: "completed" },
    messages: [{ role: "assistant", text: "ok" }],
  });
  assert.deepEqual(await readArgs(command), [
    "thread",
    "show",
    "--json",
    "--messages",
    "5",
    "mcp:thread-1",
  ]);
});

test("reports a missing CLI clearly", async () => {
  const runner = createT3CliThreadRunner({
    command: join(tmpdir(), "klein-missing-t3-command"),
  });

  await assert.rejects(runner.list(undefined), /Failed to run .*missing-t3-command/);
});
