import type { Logger } from "pino";

import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import type { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { MemoryCoordinator } from "@modules/memory/application/memory-coordinator";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { DiscordChannelRuleStore } from "@modules/discord/ports/discord-channel-rule-store";
import type { TaskCoordinator } from "./task-coordinator";
import type { ChannelSessionManager } from "./channel-session-manager";
import type { ChannelSessionState } from "./channel-session-state-store";
import type { DomainAgentRegistration } from "./agent-system";

export interface DiscordMessageIngressDependencies {
  readonly accessPolicy?: DiscordAccessPolicy;
  readonly channelRuleStore?: DiscordChannelRuleStore;
  readonly discordService: DiscordService;
  readonly domainAgents?: Readonly<Record<string, DomainAgentRegistration>>;
  readonly logger: Logger;
  readonly memoryCoordinator?: MemoryCoordinator;
  readonly operatingState: DiscordOperatingState;
  readonly ownerMemoryStore?: OwnerMemoryStore;
  readonly ownerUserId?: string;
  readonly sessionManager: ChannelSessionManager;
  readonly taskCoordinator: TaskCoordinator;
}

export class DiscordMessageIngress {
  private readonly domainChannelIds = new Set<string>();

  constructor(private readonly dependencies: DiscordMessageIngressDependencies) {
    for (const registration of Object.values(dependencies.domainAgents ?? {})) {
      if (registration.channelId) this.domainChannelIds.add(registration.channelId);
    }
  }

  handleDiscordMessage(message: DiscordMessage): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return Promise.resolve();

    this.dependencies.sessionManager.recordInbound(message.channelId);
    return this.dependencies.taskCoordinator.run(() =>
      this.dependencies.sessionManager.runForChannel(message.channelId, () =>
        this.processMessage(message),
      ),
    );
  }

  private async processMessage(message: DiscordMessage): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return;
    const isDomainChannel = this.domainChannelIds.has(message.channelId);
    const target = {
      guildId: message.guildId,
      channelId: message.parentChannelId ?? message.channelId,
      threadId: message.threadId,
      userId: message.author.id,
      userIsBot: message.author.bot,
    };
    if (isDomainChannel) {
      if (
        !this.dependencies.ownerUserId ||
        message.author.bot ||
        message.author.id !== this.dependencies.ownerUserId
      ) {
        return;
      }
    } else if (
      this.dependencies.accessPolicy &&
      !this.dependencies.accessPolicy.canReceive(target)
    ) {
      return;
    }

    const ownerFeaturesAllowed =
      isDomainChannel || (this.dependencies.accessPolicy?.canUseOwnerFeatures(target) ?? false);
    const accessScope = ownerFeaturesAllowed ? `owner:${this.dependencies.ownerUserId}` : "public";

    const logger = this.dependencies.logger.child({
      channelId: message.channelId,
      messageId: message.id,
    });
    const startedAt = Date.now();
    logger.debug({ event: "discord_message_processing_started" }, "Processing Discord message");
    let channelState: ChannelSessionState | undefined;

    try {
      const now = Date.now();
      channelState = await this.dependencies.sessionManager.getChannelState(
        message.channelId,
        now,
        accessScope,
      );
      channelState = await this.dependencies.sessionManager.rotateChannelIfDue(
        message.channelId,
        channelState,
        now,
      );
      const agent = await this.dependencies.sessionManager.getDiscordAgent(
        message.channelId,
        channelState,
      );
      if (channelState.handoffContext) {
        channelState = { ...channelState, handoffContext: undefined };
      }
      channelState = {
        ...channelState,
        hasActivitySinceRotation: true,
        lastActivityAt: now,
      };
      await this.dependencies.sessionManager.saveChannelState(channelState);

      const query = buildMemoryQuery(message);
      const guildMemory = message.guildId
        ? await this.dependencies.memoryCoordinator?.getContext(message.guildId, query)
        : undefined;
      const channelRule = message.guildId
        ? await this.dependencies.channelRuleStore?.get(message.guildId, message.channelId)
        : undefined;
      const ownerMemory = ownerFeaturesAllowed
        ? await this.dependencies.ownerMemoryStore?.getContext(query)
        : undefined;
      await agent.prompt(message, guildMemory, channelRule, ownerMemory);
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
          await this.dependencies.sessionManager.saveChannelState({
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
