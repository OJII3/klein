import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "../../agents/core/agent-definition.js";
import type { AgentFactory } from "../../agents/core/agent-factory.js";
import type { AgentRuntime } from "../../agents/core/agent-runtime.js";
import { adaptPiTools } from "./pi-tool-adapter.js";

export interface PiAgentFactoryOptions {
  readonly agentDir: string;
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

export function createPiAgentFactory({ agentDir }: PiAgentFactoryOptions): AgentFactory {
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
        resourceLoader,
        sessionManager: SessionManager.inMemory(),
        tools: [...definition.toolNames],
      });

      return new PiAgentRuntime(session);
    },
  };
}
