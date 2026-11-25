import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import pino from "pino";

import { resolveConfiguredModel } from "@runtime/pi/pi-model-runtime";
import type {
  PiSession,
  PiSessionOptions,
  PiStandaloneSessionRunner,
} from "@runtime/pi/pi-standalone-session-runner";
import { createTempDir } from "../../../../testing/temp-dir";
import { createPiCodingBackend, resolveCodingProject } from "./pi-coding-backend";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

interface FakePrompt {
  readonly text: string;
  readonly manager: SessionManager;
}

type FakeResponder = (prompt: FakePrompt) => Promise<string | undefined> | string | undefined;

function createFakeRunner(respond: FakeResponder) {
  const created: PiSessionOptions[] = [];
  const sessions: PiSession[] = [];
  const runner: Pick<PiStandaloneSessionRunner, "createSession"> = {
    async createSession(options: PiSessionOptions): Promise<PiSession> {
      created.push(options);
      const manager = options.sessionFile
        ? SessionManager.open(options.sessionFile, options.sessionDir, options.cwd)
        : SessionManager.create(options.cwd, options.sessionDir, { id: options.sessionId });
      if (options.sessionName) manager.appendSessionInfo(options.sessionName);
      const session: PiSession = {
        sessionFile: manager.getSessionFile(),
        async prompt(text) {
          manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
          const reply = await respond({ text, manager });
          if (reply !== undefined) manager.appendMessage(assistantMessage(reply));
          return reply;
        },
        dispose() {},
      };
      sessions.push(session);
      return session;
    },
  };
  return { runner, created, sessions };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: usage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function usage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createModel() {
  return resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash");
}

function createBackend(
  runner: Pick<PiStandaloneSessionRunner, "createSession">,
  sessionDir: string,
  thinkingLevel?: ThinkingLevel,
) {
  return createPiCodingBackend({
    agentDir: join(sessionDir, ".."),
    logger: pino({ level: "silent" }),
    runner,
    model: createModel(),
    sessionDir,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
}

async function createProjectDirectories(root: string): Promise<{ a: string; b: string }> {
  const a = join(root, "project-a");
  const b = join(root, "project-b");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  return { a, b };
}

test("describes the backend with no optional capabilities", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const backend = createBackend(createFakeRunner(() => "ok").runner, join(temp.path, "sessions"));

  assert.equal(backend.id, "pi");
  assert.equal(backend.label, "Pi");
  assert.deepEqual(backend.capabilities, {
    projects: false,
    worktree: false,
    questions: false,
    pullRequest: false,
  });
  assert.equal(Object.hasOwn(backend, "listProjects"), false);
});

test("starts a session and waits for its reply", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const { a: project } = await createProjectDirectories(temp.path);
  const { runner, created } = createFakeRunner(() => "Fixed the parser.");
  const sessionDir = join(temp.path, "sessions");
  const backend = createBackend(runner, sessionDir);

  const run = await backend.start({
    project,
    message: "Fix the parser.",
    title: "Fix the parser",
    wait: true,
  });

  assert.equal(run.status, "idle");
  assert.equal(run.reply, "Fixed the parser.");
  assert.deepEqual(
    {
      cwd: created[0]?.cwd,
      sessionName: created[0]?.sessionName,
      projectContext: created[0]?.projectContext,
      sessionFile: created[0]?.sessionFile,
      toolNames: created[0]?.toolNames,
    },
    {
      cwd: project,
      sessionName: "Fix the parser",
      projectContext: true,
      sessionFile: undefined,
      toolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    },
  );

  const detail = await backend.show(run.sessionId, 10);
  assert.equal(detail.session.title, "Fix the parser");
  assert.equal(detail.session.status, "idle");
  assert.deepEqual(detail.messages, [
    { role: "user", text: "Fix the parser." },
    { role: "assistant", text: "Fixed the parser." },
  ]);
});

test("returns while the run is still going when wait is false", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const { a: project } = await createProjectDirectories(temp.path);
  const deferred = createDeferred<string | undefined>();
  const backend = createBackend(
    createFakeRunner(() => deferred.promise).runner,
    join(temp.path, "sessions"),
  );

  const run = await backend.start({ project, message: "Long task.", wait: false });
  assert.equal(run.status, "running");

  const shown = await backend.show(run.sessionId, 10);
  assert.equal(shown.session.status, "running");

  deferred.resolve("Done.");
  const waited = await backend.wait({ sessionId: run.sessionId, messages: 10, timeoutMs: 1_000 });
  assert.equal(waited.timedOut, false);
  assert.equal(waited.session.status, "idle");
  assert.equal(waited.messages.at(-1)?.text, "Done.");
});

test("returns timedOut with the current session when the wait expires", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const { a: project } = await createProjectDirectories(temp.path);
  const deferred = createDeferred<string | undefined>();
  const backend = createBackend(
    createFakeRunner(() => deferred.promise).runner,
    join(temp.path, "sessions"),
  );

  const run = await backend.start({ project, message: "Keep working.", wait: false });
  const started = await backend.wait({
    sessionId: run.sessionId,
    messages: 10,
    timeoutMs: 10,
  });

  assert.equal(started.timedOut, true);
  assert.equal(started.session.status, "running");

  deferred.resolve("Finished.");
  const finished = await backend.wait({
    sessionId: run.sessionId,
    messages: 10,
    timeoutMs: 1_000,
  });
  assert.equal(finished.timedOut, false);
  assert.equal(finished.session.status, "idle");
});

test("sends a follow-up to a session restored from its file", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const { a: project } = await createProjectDirectories(temp.path);
  const sessionDir = join(temp.path, "sessions");
  const first = createFakeRunner(() => "First reply.");
  const firstBackend = createBackend(first.runner, sessionDir);
  const started = await firstBackend.start({
    project,
    message: "Start the work.",
    wait: true,
  });
  const sessionFile = first.sessions[0]?.sessionFile;
  assert.ok(sessionFile);

  const second = createFakeRunner(() => "Second reply.");
  const secondBackend = createBackend(second.runner, sessionDir);
  const run = await secondBackend.send({
    sessionId: started.sessionId,
    message: "Continue the work.",
    wait: true,
  });

  assert.equal(run.status, "idle");
  assert.equal(run.reply, "Second reply.");
  assert.equal(second.created[0]?.sessionFile, sessionFile);
  assert.equal(second.created[0]?.cwd, project);

  const detail = await secondBackend.show(started.sessionId, 10);
  assert.deepEqual(detail.messages, [
    { role: "user", text: "Start the work." },
    { role: "assistant", text: "First reply." },
    { role: "user", text: "Continue the work." },
    { role: "assistant", text: "Second reply." },
  ]);
});

test("restores a persisted session once for concurrent sends", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const { a: project } = await createProjectDirectories(temp.path);
  const sessionDir = join(temp.path, "sessions");
  const first = createFakeRunner(() => "First reply.");
  const firstBackend = createBackend(first.runner, sessionDir);
  const started = await firstBackend.start({
    project,
    message: "Start the work.",
    wait: true,
  });

  const second = createFakeRunner(() => "Follow-up.");
  const gate = createDeferred<void>();
  const runner: Pick<PiStandaloneSessionRunner, "createSession"> = {
    async createSession(options) {
      await gate.promise;
      return second.runner.createSession(options);
    },
  };
  const backend = createBackend(runner, sessionDir);

  const firstSend = backend.send({
    sessionId: started.sessionId,
    message: "First follow-up.",
    wait: true,
  });
  const secondSend = backend.send({
    sessionId: started.sessionId,
    message: "Second follow-up.",
    wait: true,
  });
  gate.resolve();
  const [firstRun, secondRun] = await Promise.all([firstSend, secondSend]);

  assert.equal(second.created.length, 1);
  assert.equal(firstRun.status, "idle");
  assert.equal(secondRun.status, "idle");
  const detail = await backend.show(started.sessionId, 10);
  assert.deepEqual(
    detail.messages.map((message) => message.text),
    [
      "Start the work.",
      "First reply.",
      "First follow-up.",
      "Follow-up.",
      "Second follow-up.",
      "Follow-up.",
    ],
  );
});

test("shows assistant text, tool calls, and compact tool results", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const { a: project } = await createProjectDirectories(temp.path);
  const { runner } = createFakeRunner(({ manager }) => {
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Running the tests." },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "bun test" } },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage: usage(),
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "991 pass\n0 fail" }],
      isError: false,
      timestamp: Date.now(),
    });
    return undefined;
  });
  const backend = createBackend(runner, join(temp.path, "sessions"));

  const run = await backend.start({ project, message: "Run the tests.", wait: true });
  const detail = await backend.show(run.sessionId, 10);

  assert.deepEqual(detail.messages, [
    { role: "user", text: "Run the tests." },
    { role: "assistant", text: "Running the tests.\n[toolCall] bash" },
    { role: "toolResult", text: "bash: 991 pass 0 fail" },
  ]);
});

test("lists sessions with and without a project filter", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const { a, b } = await createProjectDirectories(temp.path);
  const backend = createBackend(
    createFakeRunner(() => "Done.").runner,
    join(temp.path, "sessions"),
  );

  const first = await backend.start({ project: a, message: "Work in A.", wait: true });
  const second = await backend.start({ project: b, message: "Work in B.", wait: true });

  const all = await backend.list(undefined);
  assert.deepEqual(
    all.map((session) => session.id).toSorted(),
    [first.sessionId, second.sessionId].toSorted(),
  );

  const filtered = await backend.list(a);
  assert.deepEqual(
    filtered.map((session) => session.id),
    [first.sessionId],
  );
});

test("reports a failed run and keeps the session visible", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const { a: project } = await createProjectDirectories(temp.path);
  const backend = createBackend(
    createFakeRunner(() => {
      throw new Error("Provider rejected the request");
    }).runner,
    join(temp.path, "sessions"),
  );

  const run = await backend.start({ project, message: "Fail please.", wait: true });
  assert.equal(run.status, "failed");
  assert.equal(run.error, "Provider rejected the request");

  const detail = await backend.show(run.sessionId, 10);
  assert.equal(detail.session.status, "failed");
  assert.deepEqual(detail.messages, [{ role: "user", text: "Fail please." }]);
});

test("rejects an unknown session id", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const backend = createBackend(
    createFakeRunner(() => "Done.").runner,
    join(temp.path, "sessions"),
  );

  await assert.rejects(backend.show("missing", 10), /Unknown coding session "missing"/);
  await assert.rejects(
    backend.send({ sessionId: "missing", message: "Continue.", wait: true }),
    /Unknown coding session "missing"/,
  );
  await assert.rejects(
    backend.wait({ sessionId: "missing", messages: 10, timeoutMs: 10 }),
    /Unknown coding session "missing"/,
  );
});

test("resolves a project path to its git root", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  const repository = join(temp.path, "repository");
  const nested = join(repository, "apps", "server");
  await mkdir(nested, { recursive: true });
  await promisify(execFile)("git", ["init", "-q", repository]);

  assert.equal(await resolveCodingProject(nested), repository);
  assert.equal(await resolveCodingProject(repository), repository);
});

test("rejects a project path that is not a directory", async () => {
  await using temp = await createTempDir("klein-pi-coding-");
  await assert.rejects(
    resolveCodingProject(join(temp.path, "missing")),
    /Coding project path does not exist/,
  );
});

function createDeferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
