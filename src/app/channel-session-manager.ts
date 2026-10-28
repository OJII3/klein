import type { Logger } from "pino";

import type { ChannelAgent } from "@agents/core/channel-agent";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { DiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import {
  CHANNEL_ROTATION_IDLE_MS,
  createConversationSessionKey,
  getChannelRotationDate,
  isChannelRotationDue,
  serializeConversationKey,
  type ChannelSessionState,
  type ChannelSessionStateStore,
  type ConversationKey,
} from "./channel-session-state-store";

export interface ChannelSessionManagerDependencies {
  readonly accessPolicy?: DiscordAccessPolicy;
  readonly channelSessionStateStore?: ChannelSessionStateStore;
  readonly createAgent: (
    conversationKey: ConversationKey,
    sessionKey: string,
    handoffContext?: string,
    ownerFeaturesAllowed?: boolean,
  ) => Promise<ChannelAgent>;
  readonly isKnownAgent?: (agentId: string) => boolean;
  readonly isDomainChannel?: (channelId: string) => boolean;
  readonly discordService: DiscordService;
  readonly logger: Logger;
  readonly ownerUserId?: string;
}

export class ChannelSessionManager {
  private readonly agents = new Map<string, Promise<ChannelAgent>>();
  private readonly agentSessionKeys = new Map<string, string>();
  private readonly channelOperations = new Map<string, Promise<void>>();
  private readonly inMemoryChannelStates = new Map<string, ChannelSessionState>();
  private readonly latestInboundAt = new Map<string, number>();
  private rotationCheckRunning = false;

  constructor(private readonly dependencies: ChannelSessionManagerDependencies) {}

  recordInbound(conversationKey: ConversationKey): void {
    this.latestInboundAt.set(serializeConversationKey(conversationKey), Date.now());
  }

  async initialize(): Promise<void> {
    const states = await this.dependencies.channelSessionStateStore?.list();
    for (const state of states ?? []) {
      const { conversationKey } = state;
      if (
        conversationKey.kind === "agent" &&
        this.dependencies.isKnownAgent &&
        !this.dependencies.isKnownAgent(conversationKey.agentId)
      ) {
        continue;
      }
      if (
        conversationKey.kind === "discord" &&
        this.dependencies.isDomainChannel?.(conversationKey.channelId)
      ) {
        continue;
      }

      if (conversationKey.kind === "discord" && this.dependencies.accessPolicy) {
        let location: Awaited<ReturnType<DiscordService["getChannelLocation"]>>;
        try {
          location = await this.dependencies.discordService.getChannelLocation(
            conversationKey.channelId,
          );
        } catch (error) {
          this.dependencies.logger.warn(
            {
              channelId: conversationKey.channelId,
              err: error,
              event: "channel_agent_restore_failed",
            },
            "Failed to restore a saved Discord channel agent",
          );
          continue;
        }
        const target = {
          ...location,
          userId: this.dependencies.ownerUserId,
          userIsBot: false,
        };
        if (!this.dependencies.accessPolicy.canReceive(target)) continue;
        const currentScope = this.dependencies.accessPolicy.canUseOwnerFeatures(target)
          ? `owner:${this.dependencies.ownerUserId}`
          : "public";
        if (state.accessScope !== currentScope) continue;
      }
      await this.getAgent(conversationKey, state);
    }
  }

  runForConversation(
    conversationKey: ConversationKey,
    operation: () => Promise<void>,
  ): Promise<void> {
    const key = serializeConversationKey(conversationKey);
    const previous = this.channelOperations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tracked = current.then(
      () => undefined,
      () => undefined,
    );
    this.channelOperations.set(key, tracked);
    void tracked.then(() => {
      if (this.channelOperations.get(key) === tracked) {
        this.channelOperations.delete(key);
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

  async getConversationState(
    conversationKey: ConversationKey,
    now: number,
    accessScope?: string,
  ): Promise<ChannelSessionState> {
    const key = serializeConversationKey(conversationKey);
    const rotationDate = getChannelRotationDate(now);
    const existing = this.dependencies.channelSessionStateStore
      ? await this.dependencies.channelSessionStateStore.getOrCreate(conversationKey, rotationDate)
      : this.inMemoryChannelStates.get(key);
    const scopeMatches =
      conversationKey.kind === "agent" ||
      accessScope === undefined ||
      existing?.accessScope === accessScope ||
      (!this.dependencies.accessPolicy && !existing?.accessScope && accessScope === "public");
    if (existing && scopeMatches) return existing;

    const previousAgent = this.agents.get(key);
    if (previousAgent) (await previousAgent).dispose();
    this.agents.delete(key);
    this.agentSessionKeys.delete(key);

    const created: ChannelSessionState = {
      conversationKey,
      accessScope,
      sessionKey: createConversationSessionKey(conversationKey, {
        accessScope,
        useAccessScope: conversationKey.kind === "discord" && !!this.dependencies.accessPolicy,
      }),
      lastActivityAt: null,
      lastRotationDate: rotationDate,
      hasActivitySinceRotation: true,
    };
    this.inMemoryChannelStates.set(key, created);
    return created;
  }

  saveConversationState(state: ChannelSessionState): Promise<void> {
    this.inMemoryChannelStates.set(serializeConversationKey(state.conversationKey), state);
    return this.dependencies.channelSessionStateStore?.save(state) ?? Promise.resolve();
  }

  getAgent(conversationKey: ConversationKey, state: ChannelSessionState): Promise<ChannelAgent> {
    const key = serializeConversationKey(conversationKey);
    const existing = this.agents.get(key);
    if (existing && this.agentSessionKeys.get(key) === state.sessionKey) return existing;
    if (existing) {
      void existing.then((agent) => agent.dispose()).catch(() => undefined);
      this.agents.delete(key);
      this.agentSessionKeys.delete(key);
    }

    const created = this.dependencies.createAgent(
      conversationKey,
      state.sessionKey,
      state.handoffContext,
      state.accessScope === `owner:${this.dependencies.ownerUserId}` &&
        !!this.dependencies.ownerUserId,
    );
    this.agents.set(key, created);
    this.agentSessionKeys.set(key, state.sessionKey);
    void created.catch(() => {
      if (this.agents.get(key) === created) {
        this.agents.delete(key);
        this.agentSessionKeys.delete(key);
      }
    });

    return created;
  }

  async findLatestOwnerChannelId(
    excludedChannelIds: ReadonlySet<string> = new Set(),
  ): Promise<string | undefined> {
    if (!this.dependencies.ownerUserId) return undefined;
    const ownerScope = `owner:${this.dependencies.ownerUserId}`;
    const states = this.dependencies.channelSessionStateStore
      ? await this.dependencies.channelSessionStateStore.list()
      : [...this.inMemoryChannelStates.values()];
    const candidates = states
      .filter(
        (state) =>
          state.conversationKey.kind === "discord" &&
          state.accessScope === ownerScope &&
          !this.dependencies.isDomainChannel?.(state.conversationKey.channelId) &&
          !excludedChannelIds.has(state.conversationKey.channelId),
      )
      .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
    const latest = candidates[0]?.conversationKey;
    return latest?.kind === "discord" ? latest.channelId : undefined;
  }

  async rotateConversationIfDue(
    conversationKey: ConversationKey,
    state: ChannelSessionState,
    now: number,
  ): Promise<ChannelSessionState> {
    if (!isChannelRotationDue(state, now)) return state;

    const agent = await this.getAgent(conversationKey, state);
    const compaction = agent.compactForHandoff();
    if (!compaction) return state;

    let handoffContext: string;
    try {
      handoffContext = (await compaction).trim();
    } catch (error) {
      this.dependencies.logger.warn(
        { conversationKey, err: error, event: "channel_context_compaction_failed" },
        "Failed to compact the conversation context",
      );
      return state;
    }

    if (!handoffContext) {
      this.dependencies.logger.warn(
        { conversationKey, event: "channel_context_compaction_empty" },
        "Compaction produced an empty conversation handoff summary",
      );
      return state;
    }

    const rotationDate = getChannelRotationDate(now);
    const nextState: ChannelSessionState = {
      ...state,
      handoffContext,
      hasActivitySinceRotation: false,
      lastRotationDate: rotationDate,
      sessionKey: createConversationSessionKey(conversationKey, {
        accessScope: state.accessScope,
        useAccessScope: conversationKey.kind === "discord" && !!this.dependencies.accessPolicy,
        rotationDate,
      }),
    };
    await this.saveConversationState(nextState);
    agent.dispose();
    const key = serializeConversationKey(conversationKey);
    this.agents.delete(key);
    this.agentSessionKeys.delete(key);
    this.dependencies.logger.info(
      { conversationKey, event: "channel_context_rotated", rotationDate },
      "Rotated the conversation context",
    );
    return nextState;
  }

  private async checkIdleChannels(): Promise<void> {
    let conversations: readonly ConversationKey[];
    try {
      conversations = this.dependencies.channelSessionStateStore
        ? (await this.dependencies.channelSessionStateStore.list()).map(
            (state) => state.conversationKey,
          )
        : [...this.inMemoryChannelStates.values()].map((state) => state.conversationKey);
    } catch (error) {
      this.dependencies.logger.error(
        { err: error, event: "channel_session_state_list_failed" },
        "Failed to list conversation session state",
      );
      return;
    }

    for (const conversationKey of conversations) {
      if (
        conversationKey.kind === "agent" &&
        this.dependencies.isKnownAgent &&
        !this.dependencies.isKnownAgent(conversationKey.agentId)
      ) {
        continue;
      }
      if (
        conversationKey.kind === "discord" &&
        this.dependencies.isDomainChannel?.(conversationKey.channelId)
      ) {
        continue;
      }
      await this.runForConversation(conversationKey, async () => {
        try {
          const now = Date.now();
          const key = serializeConversationKey(conversationKey);
          const latestInboundAt = this.latestInboundAt.get(key);
          if (latestInboundAt && now - latestInboundAt < CHANNEL_ROTATION_IDLE_MS) return;
          const state = await this.getConversationState(conversationKey, now);
          await this.rotateConversationIfDue(conversationKey, state, now);
        } catch (error) {
          this.dependencies.logger.warn(
            { conversationKey, err: error, event: "channel_context_rotation_failed" },
            "Failed to rotate the conversation context",
          );
        }
      });
    }
  }
}
