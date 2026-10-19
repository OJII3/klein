import type { Logger } from "pino";

import type { DiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { MemoryCoordinator } from "@modules/memory/application/memory-coordinator";
import type { DiscordChannelRuleStore } from "@modules/discord/ports/discord-channel-rule-store";
import { DiscordAgent } from "@agents/discord/discord-agent";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
import type { TaskCoordinator } from "./task-coordinator";
import type { ChannelSessionState, ChannelSessionStateStore } from "./channel-session-state-store";
import { ChannelSessionManager } from "./channel-session-manager";
import { ReminderDeliveryCoordinator } from "./reminder-delivery-coordinator";

export interface AgentCoordinatorDependencies {
  readonly discordService: DiscordService;
  readonly accessPolicy?: DiscordAccessPolicy;
  readonly ownerUserId?: string;
  readonly createDiscordAgent: (
    channelId: string,
    sessionKey: string,
    handoffContext?: string,
    ownerFeaturesAllowed?: boolean,
  ) => Promise<DiscordAgent>;
  readonly channelSessionStateStore?: ChannelSessionStateStore;
  readonly channelRuleStore?: DiscordChannelRuleStore;
  readonly logger: Logger;
  readonly memoryCoordinator?: MemoryCoordinator;
  readonly operatingState: DiscordOperatingState;
  readonly reminderStore?: ReminderStore;
  readonly taskCoordinator: TaskCoordinator;
}

export class AgentCoordinator {
  private readonly logger: Logger;
  private readonly sessionManager: ChannelSessionManager;
  private readonly reminderDeliveryCoordinator: ReminderDeliveryCoordinator;

  constructor(private readonly dependencies: AgentCoordinatorDependencies) {
    this.logger = dependencies.logger.child({ component: "agent-coordinator" });
    this.sessionManager = new ChannelSessionManager({
      accessPolicy: dependencies.accessPolicy,
      channelSessionStateStore: dependencies.channelSessionStateStore,
      createDiscordAgent: dependencies.createDiscordAgent,
      logger: this.logger,
      ownerUserId: dependencies.ownerUserId,
    });
    this.reminderDeliveryCoordinator = new ReminderDeliveryCoordinator({
      accessPolicy: dependencies.accessPolicy,
      discordService: dependencies.discordService,
      logger: this.logger,
      operatingState: dependencies.operatingState,
      ownerUserId: dependencies.ownerUserId,
      reminderStore: dependencies.reminderStore,
      sessionManager: this.sessionManager,
      taskCoordinator: dependencies.taskCoordinator,
    });
  }

  handleDiscordMessage(message: DiscordMessage): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return Promise.resolve();

    this.sessionManager.recordInbound(message.channelId);
    return this.dependencies.taskCoordinator.run(() =>
      this.sessionManager.runForChannel(message.channelId, () => this.processMessage(message)),
    );
  }

  async rotateIdleChannels(): Promise<void> {
    await this.sessionManager.rotateIdleChannels();
  }

  async deliverDueReminders(now = Date.now()): Promise<void> {
    await this.reminderDeliveryCoordinator.deliverDueReminders(now);
  }

  async dispose(): Promise<void> {
    await this.sessionManager.dispose();
  }

  private async processMessage(message: DiscordMessage): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return;
    const target = {
      guildId: message.guildId,
      channelId: message.parentChannelId ?? message.channelId,
      threadId: message.threadId,
      userId: message.author.id,
      userIsBot: message.author.bot,
    };
    if (this.dependencies.accessPolicy && !this.dependencies.accessPolicy.canReceive(target))
      return;
    const ownerFeaturesAllowed =
      this.dependencies.accessPolicy?.canUseOwnerFeatures(target) ?? false;
    const accessScope = ownerFeaturesAllowed ? `owner:${this.dependencies.ownerUserId}` : "public";

    const logger = this.logger.child({
      channelId: message.channelId,
      messageId: message.id,
    });
    const startedAt = Date.now();
    logger.debug({ event: "discord_message_processing_started" }, "Processing Discord message");
    let channelState: ChannelSessionState | undefined;

    try {
      const now = Date.now();
      channelState = await this.sessionManager.getChannelState(message.channelId, now, accessScope);
      channelState = await this.sessionManager.rotateChannelIfDue(
        message.channelId,
        channelState,
        now,
      );
      const agent = await this.sessionManager.getDiscordAgent(message.channelId, channelState);
      if (channelState.handoffContext) {
        channelState = { ...channelState, handoffContext: undefined };
      }
      channelState = {
        ...channelState,
        hasActivitySinceRotation: true,
        lastActivityAt: now,
      };
      await this.sessionManager.saveChannelState(channelState);

      const guildMemory = message.guildId
        ? await this.dependencies.memoryCoordinator?.getContext(
            message.guildId,
            buildMemoryQuery(message),
          )
        : undefined;
      const channelRule = message.guildId
        ? await this.dependencies.channelRuleStore?.get(message.guildId, message.channelId)
        : undefined;
      await agent.prompt(message, guildMemory, channelRule);
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
          await this.sessionManager.saveChannelState({
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
      if (!ownerFeaturesAllowed) this.dependencies.memoryCoordinator?.enqueue(message);
    }
  }
}

function buildMemoryQuery(message: DiscordMessage): string {
  return [message.content, message.replyTo?.content].filter(Boolean).join("\n");
}
