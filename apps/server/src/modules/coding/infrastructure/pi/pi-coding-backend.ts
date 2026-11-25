import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  convertToLlm,
  parseSessionEntries,
  SessionManager,
  type CreateAgentSessionOptions,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import type {
  CodingSessionDetail,
  CodingSessionMessage,
  CodingSessionRun,
  CodingSessionSendInput,
  CodingSessionStartInput,
  CodingSessionStatus,
  CodingSessionSummary,
  CodingSessionWaitInput,
  CodingSessionWaitResult,
} from "../../domain/coding-session";
import type { CodingBackend } from "../../ports/coding-backend";
import type {
  PiSession,
  PiStandaloneSessionRunner,
} from "@runtime/pi/pi-standalone-session-runner";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface PiCodingBackendOptions {
  readonly agentDir: string;
  readonly logger: Logger;
  readonly runner: Pick<PiStandaloneSessionRunner, "createSession">;
  readonly model: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly sessionDir?: string;
}

interface SessionRunOutcome {
  readonly sessionId: string;
  readonly reply?: string;
  readonly error?: string;
}

interface LiveSession {
  readonly sessionId: string;
  readonly session: PiSession;
  title?: string;
  status: CodingSessionStatus;
  reply?: string;
  error?: string;
  pending: number;
  tail: Promise<void>;
}

const SESSION_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const MAX_MESSAGE_CHARS = 2_000;
const execFileAsync = promisify(execFile);

export function createPiCodingBackend(options: PiCodingBackendOptions): CodingBackend {
  const sessionDir = options.sessionDir ?? resolve(options.agentDir, "sessions", "coding");
  const liveSessions = new Map<string, LiveSession>();
  const restoring = new Map<string, Promise<LiveSession>>();

  const readDetail = async (sessionId: string, messages: number): Promise<CodingSessionDetail> => {
    const live = liveSessions.get(sessionId);
    const info = findSessionInfo(await listSessionInfos(), sessionId);
    if (!live && !info) {
      throw new Error(
        `Unknown coding session "${sessionId}". Use coding_session_list to find a session.`,
      );
    }
    const sessionFile = live?.session.sessionFile ?? info?.path;
    return {
      session: toSummary(sessionId, live, info),
      messages: sessionFile ? await readMessages(sessionFile, messages) : [],
    };
  };

  const listSessionInfos = (): Promise<SessionInfo[]> => SessionManager.listAll(sessionDir);

  const logBackgroundFailure = (outcome: SessionRunOutcome): void => {
    if (!outcome.error) return;
    options.logger.warn(
      {
        err: outcome.error,
        event: "coding_session_background_run_failed",
        sessionId: outcome.sessionId,
      },
      "A background coding session run failed",
    );
  };

  const startRun = async (
    live: LiveSession,
    text: string,
    wait: boolean,
    signal: AbortSignal | undefined,
  ): Promise<CodingSessionRun> => {
    const run = enqueue(live, text, wait ? signal : undefined);
    if (!wait) {
      void run.then(logBackgroundFailure);
      return { sessionId: live.sessionId, status: "running" };
    }
    const outcome = await run;
    return {
      sessionId: live.sessionId,
      status: outcome.error ? "failed" : "idle",
      ...(outcome.reply ? { reply: outcome.reply } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  };

  return {
    id: "pi",
    label: "Pi",
    capabilities: {
      projects: false,
      worktree: false,
      questions: false,
      pullRequest: false,
    },
    async list(project, _signal) {
      const resolvedProject = project ? await resolveCodingProject(project) : undefined;
      const infos = await listSessionInfos();
      return infos
        .filter((info) => resolvedProject === undefined || resolve(info.cwd) === resolvedProject)
        .toSorted((left, right) => right.modified.getTime() - left.modified.getTime())
        .map((info) => toSummary(info.id, liveSessions.get(info.id), info));
    },
    async start(input: CodingSessionStartInput, signal): Promise<CodingSessionRun> {
      const project = await resolveCodingProject(input.project);
      const sessionId = randomUUID();
      const session = await options.runner.createSession({
        cwd: project,
        model: options.model,
        sessionId,
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        toolNames: SESSION_TOOL_NAMES,
        tools: [],
        sessionDir,
        projectContext: true,
        ...(input.title ? { sessionName: input.title } : {}),
      });
      const live: LiveSession = {
        sessionId,
        session,
        ...(input.title ? { title: input.title } : {}),
        status: "idle",
        pending: 0,
        tail: Promise.resolve(),
      };
      liveSessions.set(sessionId, live);
      return startRun(live, input.message, input.wait, signal);
    },
    async send(input: CodingSessionSendInput, signal): Promise<CodingSessionRun> {
      const live = await ensureLive(input.sessionId);
      return startRun(live, input.message, input.wait, signal);
    },
    async wait(input: CodingSessionWaitInput, signal): Promise<CodingSessionWaitResult> {
      if (signal?.aborted) throw new Error("The coding session wait was aborted");
      const live = liveSessions.get(input.sessionId);
      if (!live || live.pending === 0) {
        return { ...(await readDetail(input.sessionId, input.messages)), timedOut: false };
      }
      const timedOut = await waitFor(live.tail, input.timeoutMs, signal);
      return { ...(await readDetail(input.sessionId, input.messages)), timedOut };
    },
    async show(sessionId, messages, _signal) {
      return readDetail(sessionId, messages);
    },
  };

  async function ensureLive(sessionId: string): Promise<LiveSession> {
    const live = liveSessions.get(sessionId);
    if (live) return live;
    const pending = restoring.get(sessionId);
    if (pending) return pending;
    const tracked = restore(sessionId).finally(() => {
      restoring.delete(sessionId);
    });
    restoring.set(sessionId, tracked);
    return tracked;
  }

  async function restore(sessionId: string): Promise<LiveSession> {
    const info = findSessionInfo(await listSessionInfos(), sessionId);
    if (!info) {
      throw new Error(
        `Unknown coding session "${sessionId}". Use coding_session_list to find a session.`,
      );
    }
    const project = resolve(info.cwd);
    const title = info.name ?? info.firstMessage;
    const session = await options.runner.createSession({
      cwd: project,
      model: options.model,
      sessionId: info.id,
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      toolNames: SESSION_TOOL_NAMES,
      tools: [],
      sessionDir,
      sessionFile: info.path,
      projectContext: true,
    });
    const live: LiveSession = {
      sessionId: info.id,
      session,
      ...(title ? { title } : {}),
      status: "idle",
      pending: 0,
      tail: Promise.resolve(),
    };
    liveSessions.set(info.id, live);
    return live;
  }
}

function enqueue(
  live: LiveSession,
  text: string,
  signal: AbortSignal | undefined,
): Promise<SessionRunOutcome> {
  live.status = "running";
  live.reply = undefined;
  live.error = undefined;
  live.pending += 1;
  const run = live.tail.then(async (): Promise<SessionRunOutcome> => {
    try {
      const reply = await live.session.prompt(text, signal ? { signal } : {});
      live.reply = reply;
      live.status = "idle";
      return { sessionId: live.sessionId, ...(reply ? { reply } : {}) };
    } catch (error) {
      const message = errorMessage(error);
      live.error = message;
      live.status = "failed";
      return { sessionId: live.sessionId, error: message };
    }
  });
  const settle = (): void => {
    live.pending -= 1;
  };
  live.tail = run.then(settle, settle);
  return run;
}

async function waitFor(
  tail: Promise<void>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("The coding session wait was aborted"));
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const outcome = await Promise.race([tail.then(() => "done" as const), timeout, aborted]);
    return outcome === "timeout";
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function toSummary(
  sessionId: string,
  live: LiveSession | undefined,
  info: SessionInfo | undefined,
): CodingSessionSummary {
  return {
    id: sessionId,
    title: live?.title ?? info?.name ?? info?.firstMessage ?? "",
    status: live?.status ?? "idle",
    ...(info ? { updatedAt: info.modified.toISOString() } : {}),
  };
}

function findSessionInfo(
  infos: readonly SessionInfo[],
  sessionId: string,
): SessionInfo | undefined {
  return infos.find((info) => info.id === sessionId);
}

async function readMessages(
  sessionFilePath: string,
  messages: number,
): Promise<readonly CodingSessionMessage[]> {
  let raw: string;
  try {
    raw = await readFile(sessionFilePath, "utf8");
  } catch {
    return [];
  }
  const entries = parseSessionEntries(raw).filter(
    (entry): entry is SessionEntry => entry.type !== "session",
  );
  return convertToLlm(buildSessionProjection(entries).messages)
    .slice(-messages)
    .flatMap((message) => toSessionMessage(message));
}

function toSessionMessage(message: Message): CodingSessionMessage[] {
  switch (message.role) {
    case "user": {
      const text = contentText(message.content);
      return text ? [{ role: "user", text: truncate(text) }] : [];
    }
    case "assistant": {
      const lines: string[] = [];
      const text = contentText(message.content);
      if (text) lines.push(text);
      for (const block of message.content) {
        if (block.type === "toolCall") lines.push(`[toolCall] ${block.name}`);
      }
      return lines.length > 0 ? [{ role: "assistant", text: truncate(lines.join("\n")) }] : [];
    }
    case "toolResult": {
      const text = contentText(message.content).replaceAll(/\s+/gu, " ").trim();
      const compact = text ? `${message.toolName}: ${text}` : `${message.toolName}: (no output)`;
      return [{ role: "toolResult", text: truncate(compact) }];
    }
    case "system":
      return [];
    default:
      return [];
  }
}

function contentText(content: string | readonly TextBlock[]): string {
  if (typeof content === "string") return content.trim();
  return content
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("\n")
    .trim();
}

interface TextBlock {
  readonly type: string;
  readonly text?: string;
}

function truncate(text: string): string {
  return text.length <= MAX_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_MESSAGE_CHARS)}… (truncated)`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resolveCodingProject(project?: string): Promise<string> {
  const requested = resolve(project ? expandHome(project) : process.cwd());
  let stats;
  try {
    stats = await stat(requested);
  } catch {
    throw new Error(`Coding project path does not exist: ${requested}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Coding project path is not a directory: ${requested}`);
  }
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      requested,
      "rev-parse",
      "--show-toplevel",
    ]);
    const root = stdout.trim();
    return root ? resolve(root) : requested;
  } catch {
    return requested;
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}
