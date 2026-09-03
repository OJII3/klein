import type { DiscordMessage } from "../modules/discord/domain/discord-message.js";
import type { DiscordService } from "../modules/discord/ports/discord-service.js";
import { DiscordAgent } from "../agents/discord/discord-agent.js";
import type { TaskCoordinator } from "./task-coordinator.js";

export interface AgentCoordinatorDependencies {
  readonly discordService: DiscordService;
  readonly createDiscordAgent: (channelId: string) => Promise<DiscordAgent>;
  readonly taskCoordinator: TaskCoordinator;
}

export class AgentCoordinator {
  private readonly agents = new Map<string, Promise<DiscordAgent>>();

  constructor(private readonly dependencies: AgentCoordinatorDependencies) {}

  handleDiscordMessage(message: DiscordMessage): Promise<void> {
    return this.dependencies.taskCoordinator.run(() => this.processMessage(message));
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.agents.values()].map(async (agentPromise) => {
        try {
          (await agentPromise).dispose();
        } catch {
          // The agent may fail to finish initialization during shutdown.
        }
      }),
    );
  }

  private async processMessage(message: DiscordMessage): Promise<void> {
    try {
      const agent = await this.getDiscordAgent(message.channelId);
      await agent.prompt(message.authorName, message.content);
    } catch (error) {
      console.error("Failed to handle Discord message:", error);
      await this.dependencies.discordService.sendMessage(
        message.channelId,
        "ごめん、今はうまく返答できないみたい。",
      );
    }
  }

  private getDiscordAgent(channelId: string): Promise<DiscordAgent> {
    const existing = this.agents.get(channelId);
    if (existing) return existing;

    const created = this.dependencies.createDiscordAgent(channelId);
    this.agents.set(channelId, created);
    void created.catch(() => {
      if (this.agents.get(channelId) === created) {
        this.agents.delete(channelId);
      }
    });

    return created;
  }
}
