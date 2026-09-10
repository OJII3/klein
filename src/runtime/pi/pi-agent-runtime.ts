import { resolve } from "node:path";
import type { Logger } from "pino";

import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "../../agents/core/agent-definition.js";
import type { AgentFactory, AgentCreationOptions } from "../../agents/core/agent-factory.js";
import type { AgentRuntime } from "../../agents/core/agent-runtime.js";
import type { SessionMode } from "../../app/cli-options.js";
import { createBackgroundCompactionExtension } from "./background-compaction.js";
import { adaptPiTools } from "./pi-tool-adapter.js";

export interface PiAgentFactoryOptions {
  readonly agentDir: string;
  readonly sessionMode: SessionMode;
  readonly llm: {
    readonly provider: string;
    readonly model: string;
    readonly thinkingLevel?: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
  };
  readonly logger: Logger;
}

export const KLEIN_SKILLS_DIRECTORY = "config/skills";

export function createPiSessionManager(
  agentDir: string,
  sessionKey: string,
  sessionMode: SessionMode,
  cwd = process.cwd(),
): SessionManager {
  const sessionDir = resolve(agentDir, "sessions", encodeURIComponent(sessionKey));

  return sessionMode === "resume"
    ? SessionManager.continueRecent(cwd, sessionDir)
    : SessionManager.create(cwd, sessionDir);
}

export class PiAgentRuntime implements AgentRuntime {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly session: AgentSession) {}

  prompt(content: string): Promise<void> {
    const run = this.queue.then(() => this.session.prompt(content, { source: "rpc" }));

    this.queue = run.catch(() => undefined);

    return run;
  }

  dispose(): void {
    this.session.dispose();
  }
}

export function createResourceLoader(
  agentDir: string,
  systemPrompt: string,
  settingsManager: SettingsManager,
  logger?: Logger,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    extensionFactories: [createBackgroundCompactionExtension(settingsManager, { logger })],
    settingsManager,
    additionalSkillPaths: [resolve(process.cwd(), KLEIN_SKILLS_DIRECTORY)],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    systemPrompt,
  });
}

export function resolveConfiguredModel(
  provider: string,
  modelId: string,
): NonNullable<ReturnType<ReturnType<typeof builtinModels>["getModel"]>> {
  const model = builtinModels().getModel(provider, modelId);
  if (!model) {
    throw new Error(`Configured Pi model was not found: ${provider}/${modelId}`);
  }

  return model;
}

export function createPiAgentFactory({
  agentDir,
  llm,
  logger,
  sessionMode,
}: PiAgentFactoryOptions): AgentFactory {
  const model = resolveConfiguredModel(llm.provider, llm.model);

  return {
    async create<TTool>(
      definition: AgentDefinition,
      tools: readonly TTool[],
      options: AgentCreationOptions,
    ): Promise<AgentRuntime> {
      const settingsManager = SettingsManager.create(process.cwd(), agentDir);
      const resourceLoader = createResourceLoader(
        agentDir,
        definition.systemPrompt,
        settingsManager,
        logger,
      );
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        agentDir,
        customTools: adaptPiTools(tools),
        model,
        resourceLoader,
        sessionManager: createPiSessionManager(agentDir, options.sessionKey, sessionMode),
        settingsManager,
        thinkingLevel: llm.thinkingLevel,
        tools: [...definition.toolNames],
      });

      return new PiAgentRuntime(session);
    },
  };
}
