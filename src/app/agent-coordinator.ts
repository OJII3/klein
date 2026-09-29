import type { Logger } from "pino";

import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { MemoryCoordinator } from "@modules/memory/application/memory-coordinator";
import { DiscordAgent } from "@agents/discord/discord-agent";
import type { TaskCoordinator } from "./task-coordinator";
import {
  CHANNEL_ROTATION_IDLE_MS,
  getChannelRotationDate,
  isChannelRotationDue,
  type ChannelSessionState,
  type ChannelSessionStateStore,
} from "./channel-session-state-store";

export interface AgentCoordinatorDependencies {
  readonly discordService: DiscordService;
  readonly createDiscordAgent: (
    channelId: string,
    sessionKey: string,
    handoffContext?: string,
  ) => Promise<DiscordAgent>;
  readonly channelSessionStateStore?: ChannelSessionStateStore;
  readonly logger: Logger;
  readonly memoryCoordinator?: MemoryCoordinator;
  readonly operatingState: DiscordOperatingState;
  readonly taskCoordinator: TaskCoordinator;
}

export class AgentCoordinator {
  private readonly agents = new Map<string, Promise<DiscordAgent>>();
  private readonly channelOperations = new Map<string, Promise<void>>();
  private readonly inMemoryChannelStates = new Map<string, ChannelSessionState>();
  private readonly latestInboundAt = new Map<string, number>();
  private readonly logger: Logger;
  private rotationCheckRunning = false;

  constructor(private readonly dependencies: AgentCoordinatorDependencies) {
    this.logger = dependencies.logger.child({ component: "agent-coordinator" });
  }

  handleDiscordMessage(message: DiscordMessage): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return Promise.resolve();

    this.latestInboundAt.set(message.channelId, Date.now());
    return this.dependencies.taskCoordinator.run(() =>
      this.runForChannel(message.channelId, () => this.processMessage(message)),
    );
  }

  async rotateIdleChannels(): Promise<void> {
    if (this.rotationCheckRunning) return;
    this.rotationCheckRunning = true;

    try {
      await this.checkIdleChannels();
    } finally {
      this.rotationCheckRunning = false;
    }
  }

  private async checkIdleChannels(): Promise<void> {
    let channelIds: readonly string[];
    try {
      channelIds = this.dependencies.channelSessionStateStore
        ? (await this.dependencies.channelSessionStateStore.list()).map((state) => state.channelId)
        : [...this.inMemoryChannelStates.keys()];
    } catch (error) {
      this.logger.error(
        { err: error, event: "channel_session_state_list_failed" },
        "Failed to list channel session state",
      );
      return;
    }

    for (const channelId of channelIds) {
      await this.runForChannel(channelId, async () => {
        try {
          const now = Date.now();
          const latestInboundAt = this.latestInboundAt.get(channelId);
          if (latestInboundAt && now - latestInboundAt < CHANNEL_ROTATION_IDLE_MS) return;
          const state = await this.getChannelState(channelId, now);
          await this.rotateChannelIfDue(channelId, state, now);
        } catch (error) {
          this.logger.warn(
            { channelId, err: error, event: "channel_context_rotation_failed" },
            "Failed to rotate the Discord channel context",
          );
        }
      });
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.agents.values()].map(async (agentPromise) => {
        try {
          (await agentPromise).dispose();
        } catch (error) {
          // The agent may fail to finish initialization during shutdown.
          this.logger.warn(
            { err: error, event: "discord_agent_dispose_failed" },
            "Failed to dispose Discord agent",
          );
        }
      }),
    );
  }

  private async processMessage(message: DiscordMessage): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return;

    const logger = this.logger.child({
      channelId: message.channelId,
      messageId: message.id,
    });
    const startedAt = Date.now();
    logger.debug({ event: "discord_message_processing_started" }, "Processing Discord message");
    let channelState: ChannelSessionState | undefined;

    try {
      const now = Date.now();
      channelState = await this.getChannelState(message.channelId, now);
      channelState = await this.rotateChannelIfDue(message.channelId, channelState, now);
      const agent = await this.getDiscordAgent(message.channelId, channelState);
      if (channelState.handoffContext) {
        channelState = { ...channelState, handoffContext: undefined };
      }
      channelState = {
        ...channelState,
        hasActivitySinceRotation: true,
        lastActivityAt: now,
      };
      await this.saveChannelState(channelState);

      const guildMemory = message.guildId
        ? await this.dependencies.memoryCoordinator?.getContext(
            message.guildId,
            buildMemoryQuery(message),
          )
        : undefined;
      await agent.prompt(message, guildMemory);
      logger.debug(
        {
          durationMs: Date.now() - startedAt,
          event: "discord_message_processed",
        },
        "Processed Discord message",
      );
    } catch (error) {
      logger.error(
        {
          durationMs: Date.now() - startedAt,
          err: error,
          event: "discord_message_processing_failed",
        },
        "Failed to handle Discord message",
      );
      await this.dependencies.discordService.sendMessage(
        message.channelId,
        "ごめん、今はうまく返答できないみたい。",
      );
    } finally {
      if (channelState) {
        try {
          await this.saveChannelState({
            ...channelState,
            hasActivitySinceRotation: true,
            lastActivityAt: Date.now(),
          });
        } catch (error) {
          logger.error(
            { err: error, event: "channel_session_state_save_failed" },
            "Failed to save Discord channel session state",
          );
        }
      }
      this.dependencies.memoryCoordinator?.enqueue(message);
    }
  }

  private async rotateChannelIfDue(
    channelId: string,
    state: ChannelSessionState,
    now: number,
  ): Promise<ChannelSessionState> {
    if (!isChannelRotationDue(state, now)) return state;

    const agent = await this.getDiscordAgent(channelId, state);
    const compaction = agent.compactForHandoff();
    if (!compaction) return state;

    let handoffContext: string;
    try {
      handoffContext = (await compaction).trim();
    } catch (error) {
      const deferredState = {
        ...state,
        lastRotationDate: getChannelRotationDate(now),
      };
      await this.saveChannelState(deferredState);
      this.logger.warn(
        { channelId, err: error, event: "channel_context_compaction_failed" },
        "Failed to compact the Discord channel context",
      );
      return deferredState;
    }

    if (!handoffContext) {
      const deferredState = {
        ...state,
        lastRotationDate: getChannelRotationDate(now),
      };
      await this.saveChannelState(deferredState);
      this.logger.warn(
        { channelId, event: "channel_context_compaction_empty" },
        "Compaction produced no Discord channel handoff summary",
      );
      return deferredState;
    }

    const rotationDate = getChannelRotationDate(now);
    const nextState: ChannelSessionState = {
      ...state,
      handoffContext,
      hasActivitySinceRotation: false,
      lastRotationDate: rotationDate,
      sessionKey: `discord-channel:${channelId}:rotation:${rotationDate}`,
    };
    await this.saveChannelState(nextState);
    agent.dispose();
    this.agents.delete(channelId);
    this.logger.info(
      { channelId, event: "channel_context_rotated", rotationDate },
      "Rotated the Discord channel context",
    );
    return nextState;
  }

  private async getChannelState(channelId: string, now: number): Promise<ChannelSessionState> {
    const rotationDate = getChannelRotationDate(now);
    if (this.dependencies.channelSessionStateStore) {
      return this.dependencies.channelSessionStateStore.getOrCreate(channelId, rotationDate);
    }

    const existing = this.inMemoryChannelStates.get(channelId);
    if (existing) return existing;

    const created: ChannelSessionState = {
      channelId,
      sessionKey: `discord-channel:${channelId}`,
      lastActivityAt: null,
      lastRotationDate: rotationDate,
      hasActivitySinceRotation: true,
    };
    this.inMemoryChannelStates.set(channelId, created);
    return created;
  }

  private saveChannelState(state: ChannelSessionState): Promise<void> {
    this.inMemoryChannelStates.set(state.channelId, state);
    return this.dependencies.channelSessionStateStore?.save(state) ?? Promise.resolve();
  }

  private getDiscordAgent(channelId: string, state: ChannelSessionState): Promise<DiscordAgent> {
    const existing = this.agents.get(channelId);
    if (existing) return existing;

    const created = this.dependencies.createDiscordAgent(
      channelId,
      state.sessionKey,
      state.handoffContext,
    );
    this.agents.set(channelId, created);
    void created.catch(() => {
      if (this.agents.get(channelId) === created) {
        this.agents.delete(channelId);
      }
    });

    return created;
  }

  private runForChannel(channelId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.channelOperations.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tracked = current.then(
      () => undefined,
      () => undefined,
    );
    this.channelOperations.set(channelId, tracked);
    void tracked.then(() => {
      if (this.channelOperations.get(channelId) === tracked) {
        this.channelOperations.delete(channelId);
      }
    });
    return current;
  }
}

function buildMemoryQuery(message: DiscordMessage): string {
  return [message.content, message.replyTo?.content].filter(Boolean).join("\n");
}
