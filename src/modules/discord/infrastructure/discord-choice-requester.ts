import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type ButtonInteraction,
  type Client,
} from "discord.js";
import type { Logger } from "pino";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordChoiceRequest } from "../domain/discord-choice";
import type { DiscordMessage } from "../domain/discord-message";

const CHOICE_BUTTON_PREFIX = "choice";
const ANSWERED_ACCENT_COLOR = 0x747f8d;
const MAX_PENDING_CHOICES = 100;

interface SendableChoiceChannel {
  send(payload: {
    components: ContainerBuilder[];
    flags: MessageFlags.IsComponentsV2;
  }): Promise<{ id: string }>;
}

interface PendingChoice extends DiscordChoiceRequest {
  readonly nonce: string;
  readonly channelId: string;
  readonly messageId: string;
}

function isSendableChoiceChannel(value: unknown): value is SendableChoiceChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof value.send === "function"
  );
}

function createChoiceButtonId(nonce: string, index: number): string {
  return `${CHOICE_BUTTON_PREFIX}:${nonce}:${index}`;
}

function parseChoiceButtonId(customId: string): { nonce: string; index: number } | undefined {
  const [prefix, nonce, rawIndex] = customId.split(":");
  if (prefix !== CHOICE_BUTTON_PREFIX || !nonce || rawIndex === undefined) return undefined;
  const index = Number.parseInt(rawIndex, 10);
  if (!Number.isInteger(index) || index < 0) return undefined;
  return { nonce, index };
}

/**
 * Posts a question with buttons and turns the pressed button into a message
 * from the user who answered. The answer enters the conversation through the
 * same handler as a typed message, so access checks and session routing apply.
 */
export class DiscordChoiceRequester {
  private readonly pending = new Map<string, PendingChoice>();

  constructor(
    private readonly client: Client,
    private readonly accessPolicy: DiscordAccessPolicy,
    private readonly onAnswer: (message: DiscordMessage) => Promise<void>,
    private readonly logger?: Logger,
  ) {}

  async send(channelId: string, request: DiscordChoiceRequest): Promise<string> {
    const channel = await this.client.channels.fetch(channelId);
    if (!isSendableChoiceChannel(channel)) {
      throw new Error(`Discord channel is not sendable: ${channelId}`);
    }

    const nonce = randomUUID();
    const message = await channel.send({
      components: [
        new ContainerBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(request.question))
          .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...request.options.map((label, index) =>
                new ButtonBuilder()
                  .setCustomId(createChoiceButtonId(nonce, index))
                  .setLabel(label)
                  .setStyle(ButtonStyle.Secondary),
              ),
            ),
          ),
      ],
      flags: MessageFlags.IsComponentsV2,
    });

    this.remember({ ...request, nonce, channelId, messageId: message.id });
    return message.id;
  }

  /** Returns true when the interaction was one of this requester's buttons. */
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const parsed = parseChoiceButtonId(interaction.customId);
    if (!parsed) return false;

    const pending = this.pending.get(parsed.nonce);
    if (!pending) {
      await interaction.reply({
        content: "この質問は既に回答済みか、期限切れです。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (interaction.user.id !== pending.requesterUserId) {
      await interaction.reply({
        content: "この質問に回答できるのは、質問したユーザーだけです。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (!this.canAnswer(interaction)) {
      await interaction.reply({
        content: "このチャンネルでは回答できません。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const label = pending.options[parsed.index];
    if (label === undefined) {
      await interaction.reply({
        content: "この選択肢は無効です。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    this.pending.delete(parsed.nonce);

    try {
      await interaction.update({
        components: [
          new ContainerBuilder()
            .setAccentColor(ANSWERED_ACCENT_COLOR)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `${pending.question}\n→ ${label}（<@${interaction.user.id}>）`,
              ),
            ),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          event: "discord_choice_message_update_failed",
          channelId: pending.channelId,
          messageId: pending.messageId,
        },
        "Failed to update the answered Discord choice message",
      );
    }

    try {
      await this.onAnswer(createAnswerMessage(interaction, pending, label));
    } catch (error) {
      this.logger?.error(
        {
          err: error,
          event: "discord_choice_answer_delivery_failed",
          channelId: pending.channelId,
          messageId: pending.messageId,
        },
        "Failed to deliver a Discord choice answer",
      );
    }
    return true;
  }

  clear(): void {
    this.pending.clear();
  }

  private remember(pending: PendingChoice): void {
    this.pending.set(pending.nonce, pending);
    while (this.pending.size > MAX_PENDING_CHOICES) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) return;
      this.pending.delete(oldest);
    }
  }

  private canAnswer(interaction: ButtonInteraction): boolean {
    const channel = interaction.channel;
    const thread = channel?.isThread() ? channel : undefined;
    return this.accessPolicy.canReceive({
      guildId: interaction.guildId ?? undefined,
      channelId: thread?.parentId ?? interaction.channelId,
      threadId: thread?.id,
      userId: interaction.user.id,
      userIsBot: interaction.user.bot,
    });
  }
}

function createAnswerMessage(
  interaction: ButtonInteraction,
  pending: PendingChoice,
  label: string,
): DiscordMessage {
  const channel = interaction.channel;
  const thread = channel?.isThread() ? channel : undefined;
  const channelName =
    channel && "name" in channel && typeof channel.name === "string" && channel.name
      ? channel.name
      : undefined;
  const botUser = interaction.client.user;

  return {
    id: interaction.id,
    occurredAt: new Date().toISOString(),
    channelId: interaction.channelId,
    ...(channelName ? { channelName } : {}),
    ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
    ...(thread?.parentId ? { parentChannelId: thread.parentId } : {}),
    ...(thread?.id ? { threadId: thread.id } : {}),
    author: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
      bot: interaction.user.bot,
    },
    content: label,
    images: [],
    replyTo: {
      id: pending.messageId,
      ...(botUser
        ? {
            author: {
              id: botUser.id,
              username: botUser.username,
              displayName: botUser.displayName,
              bot: true,
            },
          }
        : {}),
      content: pending.question,
    },
  };
}
