import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "../../agents/core/agent-definition.js";
import type { AgentFactory } from "../../agents/core/agent-factory.js";
import type { AgentRuntime } from "../../agents/core/agent-runtime.js";
import { adaptPiTools } from "./pi-tool-adapter.js";

export interface PiAgentFactoryOptions {
  readonly agentDir: string;
  readonly llm: {
    readonly provider: string;
    readonly model: string;
    readonly thinkingLevel?: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
  };
}

export class PiAgentRuntime implements AgentRuntime {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly session: AgentSession) {}

  prompt(content: string): Promise<void> {
    const run = this.queue.then(() => this.session.prompt(content, { source: "rpc" }));

    this.queue = run.catch((error: unknown) => {
      console.error("Pi agent prompt failed:", error);
    });

    return run;
  }

  dispose(): void {
    this.session.dispose();
  }
}

function createResourceLoader(agentDir: string, systemPrompt: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
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

export function createPiAgentFactory({ agentDir, llm }: PiAgentFactoryOptions): AgentFactory {
  const model = resolveConfiguredModel(llm.provider, llm.model);

  return {
    async create<TTool>(
      definition: AgentDefinition,
      tools: readonly TTool[],
    ): Promise<AgentRuntime> {
      const resourceLoader = createResourceLoader(agentDir, definition.systemPrompt);
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        agentDir,
        customTools: adaptPiTools(tools),
        model,
        resourceLoader,
        sessionManager: SessionManager.inMemory(),
        thinkingLevel: llm.thinkingLevel,
        tools: [...definition.toolNames],
      });

      return new PiAgentRuntime(session);
    },
  };
}
