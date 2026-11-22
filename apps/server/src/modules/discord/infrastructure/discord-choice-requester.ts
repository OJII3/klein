import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import type { Logger } from "pino";

import {
  DiscordChoiceService,
  type DiscordChoiceAnsweredView,
  type DiscordChoiceQuestionView,
  type DiscordChoiceRejection,
} from "../application/discord-choice-service";
import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import type {
  DiscordChoiceButton,
  DiscordChoiceChannel,
  DiscordChoiceRequest,
} from "../domain/discord-choice";
import type { DiscordMessage } from "../domain/discord-message";
import { createTextContainer, type DiscordContainerMessage } from "./discord-component-message";

const REJECTION_MESSAGES: Readonly<Record<DiscordChoiceRejection, string>> = {
  expired: "この質問は既に回答済みか、期限切れです。",
  "not-requester": "この質問に回答できるのは、質問したユーザーだけです。",
  "channel-denied": "このチャンネルでは回答できません。",
  "invalid-option": "この選択肢は無効です。",
};

interface SendableChoiceChannel {
  send(payload: DiscordContainerMessage): Promise<{ id: string }>;
}

function isSendableChoiceChannel(value: unknown): value is SendableChoiceChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof value.send === "function"
  );
}

export interface DiscordChoiceClient {
  readonly channels: { fetch(id: string): Promise<unknown> };
}

export interface DiscordChoiceChannelView {
  readonly id: string;
  readonly name?: string | null;
  readonly parentId?: string | null;
  isThread(): boolean;
}

export interface DiscordChoiceButtonInteraction {
  readonly id: string;
  readonly customId: string;
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly bot: boolean;
  };
  readonly guildId: string | null;
  readonly channelId: string;
  readonly channel: DiscordChoiceChannelView | null;
  readonly client: {
    readonly user: {
      readonly id: string;
      readonly username: string;
      readonly displayName: string;
    } | null;
  };
  reply(options: { content: string; flags: MessageFlags.Ephemeral }): Promise<unknown>;
  update(options: DiscordContainerMessage): Promise<unknown>;
}

function toChoiceChannel(channel: DiscordChoiceChannelView): DiscordChoiceChannel {
  return {
    id: channel.id,
    ...(channel.name ? { name: channel.name } : {}),
    ...(channel.parentId ? { parentId: channel.parentId } : {}),
    isThread: channel.isThread(),
  };
}

function toChoiceButton(interaction: DiscordChoiceButtonInteraction): DiscordChoiceButton {
  const botUser = interaction.client.user;
  return {
    id: interaction.id,
    customId: interaction.customId,
    channelId: interaction.channelId,
    ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
    ...(interaction.channel ? { channel: toChoiceChannel(interaction.channel) } : {}),
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
      bot: interaction.user.bot,
    },
    ...(botUser
      ? {
          botUser: {
            id: botUser.id,
            username: botUser.username,
            displayName: botUser.displayName,
            bot: true,
          },
        }
      : {}),
  };
}

export class DiscordChoiceRequester {
  private readonly service: DiscordChoiceService;

  constructor(
    private readonly client: DiscordChoiceClient,
    accessPolicy: DiscordAccessPolicy,
    private readonly onAnswer: (message: DiscordMessage) => Promise<void>,
    private readonly logger?: Logger,
  ) {
    this.service = new DiscordChoiceService(accessPolicy);
  }

  send(channelId: string, request: DiscordChoiceRequest): Promise<string> {
    return this.service.send(channelId, request, (view) => this.postQuestion(view));
  }

  async handleButton(interaction: DiscordChoiceButtonInteraction): Promise<boolean> {
    const result = this.service.handleButton(toChoiceButton(interaction));

    switch (result.kind) {
      case "ignored":
        return false;
      case "rejected":
        await interaction.reply({
          content: REJECTION_MESSAGES[result.reason],
          flags: MessageFlags.Ephemeral,
        });
        return true;
      case "answered":
        await this.markAnswered(interaction, result.view);
        await this.deliverAnswer(result.answer);
        return true;
      default:
        return false;
    }
  }

  clear(): void {
    this.service.clear();
  }

  private async postQuestion(view: DiscordChoiceQuestionView): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(view.channelId);
    if (!isSendableChoiceChannel(channel)) {
      throw new Error(`Discord channel is not sendable: ${view.channelId}`);
    }

    const container = createTextContainer(view.question).addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...view.options.map((label, index) =>
          new ButtonBuilder()
            .setCustomId(view.buttonIds[index] ?? "")
            .setLabel(label)
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    );

    const message = await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    return { messageId: message.id };
  }

  private async markAnswered(
    interaction: DiscordChoiceButtonInteraction,
    view: DiscordChoiceAnsweredView,
  ): Promise<void> {
    try {
      await interaction.update({
        components: [
          createTextContainer(`${view.question}\n→ ${view.label}（<@${view.userId}>）`, "neutral"),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          event: "discord_choice_message_update_failed",
          channelId: interaction.channelId,
        },
        "Failed to update the answered Discord choice message",
      );
    }
  }

  private async deliverAnswer(answer: DiscordMessage): Promise<void> {
    try {
      await this.onAnswer(answer);
    } catch (error) {
      this.logger?.error(
        {
          err: error,
          event: "discord_choice_answer_delivery_failed",
          channelId: answer.channelId,
          messageId: answer.replyTo?.id,
        },
        "Failed to deliver a Discord choice answer",
      );
    }
  }
}
