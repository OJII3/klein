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
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import { assertSurfaceToolsAllowed } from "@agents/core/agent-role";
import { withOpenCodeSessionHeader } from "./pi-model-runtime";
import type { PiTool } from "./pi-tool";
import { readLastAssistantText } from "./pi-assistant-text";
import { PiRuntimeTrace } from "./pi-runtime-trace";
import type { PiUsageReporter } from "./pi-usage-reporter";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export type CompleteSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface PiStandaloneSessionRunnerOptions {
  readonly agentDir: string;
  readonly logger: Logger;
  readonly modelRuntime: ModelRuntime;
  readonly usageReporter?: Pick<PiUsageReporter, "recordAssistantMessage">;
}

export interface PiSessionOptions {
  readonly cwd: string;
  readonly model: Model<Api>;
  readonly sessionId: string;
  readonly systemPrompt?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly toolNames: readonly string[];
  readonly tools: readonly PiTool[];
  readonly extensions?: readonly ExtensionFactory[];
  readonly sessionDir?: string;
  readonly sessionFile?: string;
  readonly projectContext?: boolean;
  readonly sessionName?: string;
}

export interface PiSessionPromptOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PiSession {
  readonly sessionFile?: string;
  prompt(text: string, options?: PiSessionPromptOptions): Promise<string | undefined>;
  dispose(): void;
}

/**
 * Runs standalone agents against Pi. A standalone agent belongs to no
 * conversation: it never writes to a conversation surface, and its result
 * returns to the caller. One-shot completions keep the caller's prompt and
 * parsing; agent sessions get a persisted session file under
 * `sessions/standalone/` with only the tools the caller passes in.
 */
export class PiStandaloneSessionRunner {
  constructor(private readonly options: PiStandaloneSessionRunnerOptions) {}

  createCompleter(sessionId: string): CompleteSimple {
    return (model, context, options) => this.complete(model, context, options, sessionId);
  }

  async createSession(options: PiSessionOptions): Promise<PiSession> {
    const role = { kind: "standalone" } as const;
    assertSurfaceToolsAllowed(role, options.tools);
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
      noContextFiles: options.projectContext !== true,
      systemPrompt: options.systemPrompt,
    });
    await resourceLoader.reload();

    const sessionDir =
      options.sessionDir ?? standaloneSessionDir(this.options.agentDir, options.sessionId);
    const sessionManager = options.sessionFile
      ? SessionManager.open(options.sessionFile, sessionDir, options.cwd)
      : SessionManager.create(
          options.cwd,
          sessionDir,
          /*
           * Why: standalone callers use display keys such as "shared-memory-x:guild-a" that pi
           * rejects as session ids, and they relied on a generated file id. Only the coding
           * backend passes a sessionDir and needs the persisted id to match what it resumes by.
           */
          options.sessionDir ? { id: options.sessionId } : undefined,
        );
    if (options.sessionName) sessionManager.appendSessionInfo(options.sessionName);
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
        role: "standalone",
        sessionId: options.sessionId,
      }),
      { usageReporter: this.options.usageReporter },
    );
    trace.attach(session);

    return {
      sessionFile: sessionManager.getSessionFile(),
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

export function standaloneSessionDir(agentDir: string, sessionId: string): string {
  return resolve(agentDir, "sessions", "standalone", encodeURIComponent(sessionId));
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
    return readLastAssistantText(session);
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", handleAbort);
  }
}
