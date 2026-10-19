import type { Logger } from "pino";

import { DiscordAgent } from "@agents/discord/discord-agent";
import type { DiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import {
  CHANNEL_ROTATION_IDLE_MS,
  getChannelRotationDate,
  isChannelRotationDue,
  type ChannelSessionState,
  type ChannelSessionStateStore,
} from "./channel-session-state-store";

export interface ChannelSessionManagerDependencies {
  readonly accessPolicy?: DiscordAccessPolicy;
  readonly channelSessionStateStore?: ChannelSessionStateStore;
  readonly createDiscordAgent: (
    channelId: string,
    sessionKey: string,
    handoffContext?: string,
    ownerFeaturesAllowed?: boolean,
  ) => Promise<DiscordAgent>;
  readonly logger: Logger;
  readonly ownerUserId?: string;
}

export class ChannelSessionManager {
  private readonly agents = new Map<string, Promise<DiscordAgent>>();
  private readonly agentSessionKeys = new Map<string, string>();
  private readonly channelOperations = new Map<string, Promise<void>>();
  private readonly inMemoryChannelStates = new Map<string, ChannelSessionState>();
  private readonly latestInboundAt = new Map<string, number>();
  private rotationCheckRunning = false;

  constructor(private readonly dependencies: ChannelSessionManagerDependencies) {}

  recordInbound(channelId: string): void {
    this.latestInboundAt.set(channelId, Date.now());
  }

  runForChannel(channelId: string, operation: () => Promise<void>): Promise<void> {
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

  async rotateIdleChannels(): Promise<void> {
    if (this.rotationCheckRunning) return;
    this.rotationCheckRunning = true;

    try {
      await this.checkIdleChannels();
    } finally {
      this.rotationCheckRunning = false;
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.agents.values()].map(async (agentPromise) => {
        try {
          (await agentPromise).dispose();
        } catch (error) {
          // The agent may fail to finish initialization during shutdown.
          this.dependencies.logger.warn(
            { err: error, event: "discord_agent_dispose_failed" },
            "Failed to dispose Discord agent",
          );
        }
      }),
    );
    this.agents.clear();
    this.agentSessionKeys.clear();
  }

  async getChannelState(
    channelId: string,
    now: number,
    accessScope?: string,
  ): Promise<ChannelSessionState> {
    const rotationDate = getChannelRotationDate(now);
    const existing = this.dependencies.channelSessionStateStore
      ? await this.dependencies.channelSessionStateStore.getOrCreate(channelId, rotationDate)
      : this.inMemoryChannelStates.get(channelId);
    if (
      existing &&
      (accessScope === undefined ||
        existing.accessScope === accessScope ||
        (!this.dependencies.accessPolicy && !existing.accessScope && accessScope === "public"))
    ) {
      return existing;
    }
    const previousAgent = this.agents.get(channelId);
    if (previousAgent) (await previousAgent).dispose();
    this.agents.delete(channelId);
    this.agentSessionKeys.delete(channelId);

    const created: ChannelSessionState = {
      channelId,
      accessScope,
      sessionKey: this.dependencies.accessPolicy
        ? `discord-channel:${channelId}:${accessScope ?? "public"}`
        : `discord-channel:${channelId}`,
      lastActivityAt: null,
      lastRotationDate: rotationDate,
      hasActivitySinceRotation: true,
    };
    this.inMemoryChannelStates.set(channelId, created);
    return created;
  }

  saveChannelState(state: ChannelSessionState): Promise<void> {
    this.inMemoryChannelStates.set(state.channelId, state);
    return this.dependencies.channelSessionStateStore?.save(state) ?? Promise.resolve();
  }

  getDiscordAgent(channelId: string, state: ChannelSessionState): Promise<DiscordAgent> {
    const existing = this.agents.get(channelId);
    if (existing && this.agentSessionKeys.get(channelId) === state.sessionKey) return existing;
    if (existing) {
      void existing.then((agent) => agent.dispose()).catch(() => undefined);
      this.agents.delete(channelId);
      this.agentSessionKeys.delete(channelId);
    }

    const created = this.dependencies.createDiscordAgent(
      channelId,
      state.sessionKey,
      state.handoffContext,
      state.accessScope === `owner:${this.dependencies.ownerUserId}` &&
        !!this.dependencies.ownerUserId,
    );
    this.agents.set(channelId, created);
    this.agentSessionKeys.set(channelId, state.sessionKey);
    void created.catch(() => {
      if (this.agents.get(channelId) === created) {
        this.agents.delete(channelId);
        this.agentSessionKeys.delete(channelId);
      }
    });

    return created;
  }

  async rotateChannelIfDue(
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
      this.dependencies.logger.warn(
        { channelId, err: error, event: "channel_context_compaction_failed" },
        "Failed to compact the Discord channel context",
      );
      return state;
    }

    if (!handoffContext) {
      this.dependencies.logger.warn(
        { channelId, event: "channel_context_compaction_empty" },
        "Compaction produced no Discord channel handoff summary",
      );
      return state;
    }

    const rotationDate = getChannelRotationDate(now);
    const nextState: ChannelSessionState = {
      ...state,
      handoffContext,
      hasActivitySinceRotation: false,
      lastRotationDate: rotationDate,
      sessionKey: this.dependencies.accessPolicy
        ? `discord-channel:${channelId}:${state.accessScope ?? "public"}:rotation:${rotationDate}`
        : `discord-channel:${channelId}:rotation:${rotationDate}`,
    };
    await this.saveChannelState(nextState);
    agent.dispose();
    this.agents.delete(channelId);
    this.agentSessionKeys.delete(channelId);
    this.dependencies.logger.info(
      { channelId, event: "channel_context_rotated", rotationDate },
      "Rotated the Discord channel context",
    );
    return nextState;
  }

  private async checkIdleChannels(): Promise<void> {
    let channelIds: readonly string[];
    try {
      channelIds = this.dependencies.channelSessionStateStore
        ? (await this.dependencies.channelSessionStateStore.list()).map((state) => state.channelId)
        : [...this.inMemoryChannelStates.keys()];
    } catch (error) {
      this.dependencies.logger.error(
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
          this.dependencies.logger.warn(
            { channelId, err: error, event: "channel_context_rotation_failed" },
            "Failed to rotate the Discord channel context",
          );
        }
      });
    }
  }
}
