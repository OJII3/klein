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
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import { withOpenCodeSessionHeader } from "./pi-model-runtime";
import { PiRuntimeTrace } from "./pi-runtime-trace";
import type { PiUsageReporter } from "./pi-usage-reporter";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export type CompleteSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface PiBackgroundRunnerOptions {
  readonly agentDir: string;
  readonly logger: Logger;
  readonly modelRuntime: ModelRuntime;
  readonly usageReporter?: PiUsageReporter;
}

export interface PiBackgroundSessionOptions {
  readonly cwd: string;
  readonly model: Model<Api>;
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly toolNames: readonly string[];
  readonly tools: readonly ToolDefinition[];
}

export interface PiBackgroundPromptOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PiBackgroundSession {
  prompt(text: string, options?: PiBackgroundPromptOptions): Promise<void>;
  dispose(): void;
}

/**
 * Runs background work against Pi without the foreground channel tooling. One-shot
 * completions keep the caller's prompt and parsing; agent sessions get an in-memory
 * session with only the tools the caller passes in.
 */
export class PiBackgroundRunner {
  constructor(private readonly options: PiBackgroundRunnerOptions) {}

  createCompleter(sessionId: string): CompleteSimple {
    return (model, context, options) => this.complete(model, context, options, sessionId);
  }

  async createSession(options: PiBackgroundSessionOptions): Promise<PiBackgroundSession> {
    const settingsManager = SettingsManager.create(options.cwd, this.options.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: this.options.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: options.systemPrompt,
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.inMemory(options.cwd);
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
      this.options.logger.child({ component: "pi-background", sessionId: options.sessionId }),
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

async function promptSession(
  session: AgentSession,
  text: string,
  options: PiBackgroundPromptOptions = {},
): Promise<void> {
  if (options.signal?.aborted) throw new Error("Background agent was aborted");

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
    if (options.signal?.aborted) throw new Error("Background agent was aborted");
    if (timedOut) {
      throw new Error(`Background agent timed out after ${options.timeoutMs} ms`);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", handleAbort);
  }
}
