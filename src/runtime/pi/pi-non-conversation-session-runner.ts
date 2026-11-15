import { resolve } from "node:path";

import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ExtensionFactory,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import { assertSurfaceToolsAllowed, type NonConversationAgentRole } from "@agents/core/agent-role";
import { withOpenCodeSessionHeader } from "./pi-model-runtime";
import { PiRuntimeTrace } from "./pi-runtime-trace";
import type { PiUsageReporter } from "./pi-usage-reporter";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export type CompleteSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface PiNonConversationSessionRunnerOptions {
  readonly agentDir: string;
  readonly logger: Logger;
  readonly modelRuntime: ModelRuntime;
  readonly usageReporter?: PiUsageReporter;
}

export interface PiSessionOptions {
  readonly role: NonConversationAgentRole;
  readonly cwd: string;
  readonly model: Model<Api>;
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly toolNames: readonly string[];
  readonly tools: readonly ToolDefinition[];
  readonly extensions?: readonly ExtensionFactory[];
}

export interface PiSessionPromptOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PiSession {
  prompt(text: string, options?: PiSessionPromptOptions): Promise<string | undefined>;
  dispose(): void;
}

/**
 * Runs Pi sessions for roles that do not own a conversation surface. The role
 * decides the session directory and the trace label, so an attached agent and
 * a standalone agent stay distinguishable in storage and logs. One-shot
 * completions keep the caller's prompt and parsing.
 */
export class PiNonConversationSessionRunner {
  constructor(private readonly options: PiNonConversationSessionRunnerOptions) {}

  createCompleter(sessionId: string): CompleteSimple {
    return (model, context, options) => this.complete(model, context, options, sessionId);
  }

  async createSession(options: PiSessionOptions): Promise<PiSession> {
    assertSurfaceToolsAllowed(options.role, [
      ...options.toolNames,
      ...options.tools.map((tool) => tool.name),
    ]);
    const settingsManager = SettingsManager.create(options.cwd, this.options.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: this.options.agentDir,
      settingsManager,
      extensionFactories: [...(options.extensions ?? [])],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: options.systemPrompt,
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.create(
      options.cwd,
      roleSessionDir(this.options.agentDir, options.role, options.sessionId),
    );
    const model = withOpenCodeSessionHeader(options.model, options.sessionId);
    const { session } = await createAgentSession({
      cwd: options.cwd,
      agentDir: this.options.agentDir,
      customTools: [...options.tools],
      model,
      modelRuntime: this.options.modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      thinkingLevel: options.thinkingLevel,
      tools: [...options.toolNames],
    });

    const trace = new PiRuntimeTrace(
      this.options.logger.child({
        component: "pi-session",
        role: options.role.kind,
        ...(options.role.kind === "attached" ? { taskId: options.role.taskId } : {}),
        sessionId: options.sessionId,
      }),
      { usageReporter: this.options.usageReporter },
    );
    trace.attach(session);

    return {
      prompt: (text, promptOptions) => promptSession(session, text, promptOptions),
      dispose: () => {
        trace.dispose();
        session.dispose();
      },
    };
  }

  private async complete(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    sessionId: string,
  ): Promise<AssistantMessage> {
    const response = await this.options.modelRuntime.completeSimple(
      withOpenCodeSessionHeader(model, sessionId),
      context,
      { ...options, sessionId },
    );
    this.options.usageReporter?.recordAssistantMessage(sessionId, response);
    return response;
  }
}

/**
 * Directory holding the session files of one non-conversation session. The
 * role decides the directory, so attached tasks and standalone runs never
 * share a namespace.
 */
export function roleSessionDir(
  agentDir: string,
  role: NonConversationAgentRole,
  sessionId: string,
): string {
  return resolve(agentDir, "sessions", role.kind, encodeURIComponent(sessionId));
}

async function promptSession(
  session: AgentSession,
  text: string,
  options: PiSessionPromptOptions = {},
): Promise<string | undefined> {
  if (options.signal?.aborted) throw new Error("Agent session was aborted");

  let timedOut = false;
  const abort = (): void => {
    void session.abort();
  };
  const handleAbort = (): void => abort();
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          abort();
        }, options.timeoutMs);

  try {
    await session.prompt(text, { expandPromptTemplates: false });
    if (options.signal?.aborted) throw new Error("Agent session was aborted");
    if (timedOut) {
      throw new Error(`Agent session timed out after ${options.timeoutMs} ms`);
    }
    return lastAssistantText(session);
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", handleAbort);
  }
}

function lastAssistantText(session: AgentSession): string | undefined {
  const message = [...session.messages]
    .reverse()
    .find((candidate) => candidate.role === "assistant");
  if (!message) return undefined;

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || undefined;
}
