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

import { assertSurfaceToolsAllowed } from "@agents/core/agent-role";
import { withOpenCodeSessionHeader } from "./pi-model-runtime";
import { PiRuntimeTrace } from "./pi-runtime-trace";
import type { PiUsageReporter } from "./pi-usage-reporter";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export type CompleteSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface PiStandaloneRunnerOptions {
  readonly agentDir: string;
  readonly logger: Logger;
  readonly modelRuntime: ModelRuntime;
  readonly usageReporter?: PiUsageReporter;
}

export interface PiStandaloneSessionOptions {
  readonly cwd: string;
  readonly model: Model<Api>;
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly toolNames: readonly string[];
  readonly tools: readonly ToolDefinition[];
  readonly extensions?: readonly ExtensionFactory[];
}

export interface PiStandalonePromptOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PiStandaloneSession {
  prompt(text: string, options?: PiStandalonePromptOptions): Promise<string | undefined>;
  dispose(): void;
}

/**
 * Runs standalone agents against Pi. A standalone agent belongs to no
 * conversation: it never writes to a conversation surface, and its result
 * returns to the caller. One-shot completions keep the caller's prompt and
 * parsing; agent sessions get a persisted session file under the agent
 * directory with only the tools the caller passes in.
 */
export class PiStandaloneRunner {
  constructor(private readonly options: PiStandaloneRunnerOptions) {}

  createCompleter(sessionId: string): CompleteSimple {
    return (model, context, options) => this.complete(model, context, options, sessionId);
  }

  async createSession(options: PiStandaloneSessionOptions): Promise<PiStandaloneSession> {
    const role = { kind: "standalone" } as const;
    assertSurfaceToolsAllowed(role, [
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
      standaloneSessionDir(this.options.agentDir, options.sessionId),
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
      this.options.logger.child({ component: "pi-standalone", sessionId: options.sessionId }),
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

/** Directory under `sessions/` that holds standalone agent sessions. */
export const STANDALONE_SESSION_DIRECTORY = "standalone";

/**
 * Directory holding the session files of one standalone session id. Each
 * `createSession` call writes a new file under it, so the transcript of every
 * run survives the process.
 */
export function standaloneSessionDir(agentDir: string, sessionId: string): string {
  return resolve(agentDir, "sessions", STANDALONE_SESSION_DIRECTORY, encodeURIComponent(sessionId));
}

async function promptSession(
  session: AgentSession,
  text: string,
  options: PiStandalonePromptOptions = {},
): Promise<string | undefined> {
  if (options.signal?.aborted) throw new Error("Standalone agent was aborted");

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
    if (options.signal?.aborted) throw new Error("Standalone agent was aborted");
    if (timedOut) {
      throw new Error(`Standalone agent timed out after ${options.timeoutMs} ms`);
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
