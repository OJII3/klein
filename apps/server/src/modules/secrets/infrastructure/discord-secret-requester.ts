import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ContainerBuilder,
} from "discord.js";
import type { Logger } from "pino";

import type {
  SecretControl,
  SecretRequestOutcome,
  SecretSubmissionOutcome,
} from "../application/secret-service";
import type { SecretRequest, SecretRequestDraft } from "../domain/secret-request";
import { normalizeSecretLabel } from "../domain/secret";
import {
  createEphemeralTextContainerMessage,
  createTextContainer,
  createTextContainerMessage,
  type DiscordContainerMessage,
  type DiscordEphemeralContainerMessage,
  type DiscordMessageTone,
} from "../../discord/infrastructure/discord-component-message";

const SECRET_BUTTON_PREFIX = "klein-secret";
const SECRET_MODAL_PREFIX = "klein-secret-modal";
const SECRET_FIELD_PREFIX = "klein-secret-field";

const MODAL_TITLE_LIMIT = 45;

export interface DiscordSecretButtonInteraction {
  readonly customId: string;
  readonly user: { readonly id: string };
  reply(options: { content: string; flags: MessageFlags.Ephemeral }): Promise<unknown>;
  update(options: DiscordContainerMessage): Promise<unknown>;
  showModal(modal: ModalBuilder): Promise<unknown>;
}

export interface DiscordSecretModalSubmitInteraction {
  readonly customId: string;
  readonly user: { readonly id: string };
  readonly fields: { getTextInputValue(customId: string): string };
  reply(options: DiscordEphemeralContainerMessage): Promise<unknown>;
}

export interface DiscordSecretClient {
  readonly channels: { fetch(id: string): Promise<unknown> };
  readonly users: {
    fetch(id: string): Promise<{
      send(payload: DiscordContainerMessage): Promise<unknown>;
    }>;
  };
}

export interface DiscordSecretRequesterDependencies {
  readonly client: DiscordSecretClient;
  readonly service: SecretControl;
  readonly logger?: Logger;
}

interface SendableMessage {
  readonly id: string;
  readonly channelId: string;
}

interface FetchableMessageChannel {
  readonly messages: { fetch(messageId: string): Promise<unknown> };
}

interface EditableMessage {
  edit(payload: DiscordContainerMessage): Promise<unknown>;
}

/**
 * Presents a worker's secret request in the linked user's direct messages.
 * A button opens a modal, and only the modal submit carries the values. The
 * values never pass through the conversation channel or the model.
 */
export class DiscordSecretRequester {
  constructor(private readonly dependencies: DiscordSecretRequesterDependencies) {}

  async request(draft: SecretRequestDraft): Promise<SecretRequestOutcome> {
    const outcome = await this.dependencies.service.request(draft);
    if (outcome.kind !== "requested") return outcome;

    let message: unknown;
    try {
      const user = await this.dependencies.client.users.fetch(outcome.request.userId);
      message = await user.send(createRequestMessage(outcome.request));
    } catch (error) {
      await this.dependencies.service.abandon(outcome.request.requestId);
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "secret_request_dm_failed",
          userId: outcome.request.userId,
          requestId: outcome.request.requestId,
        },
        "Failed to send an secret request by direct message",
      );
      return { kind: "unavailable" };
    }

    if (isSentMessage(message)) {
      try {
        await this.dependencies.service.attachMessage(
          outcome.request.requestId,
          message.channelId,
          message.id,
        );
      } catch (error) {
        this.dependencies.logger?.warn(
          {
            err: error,
            event: "secret_request_message_attach_failed",
            requestId: outcome.request.requestId,
          },
          "Failed to remember the secret request direct message",
        );
      }
    }
    return outcome;
  }

  async handleButton(interaction: DiscordSecretButtonInteraction): Promise<boolean> {
    const parsed = parseButtonId(interaction.customId);
    if (!parsed) return false;

    const lookup = await this.dependencies.service.lookupPending(parsed.requestId);
    if (lookup.kind !== "pending") {
      await this.replyExpired(interaction);
      return true;
    }
    if (lookup.request.userId !== interaction.user.id) {
      await interaction.reply({
        content: "このシークレットリクエストを操作できるのは、依頼された本人だけです。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (parsed.action === "cancel") {
      const outcome = await this.dependencies.service.cancel(parsed.requestId, interaction.user.id);
      if (outcome.kind === "cancelled") {
        await interaction.update(
          createTextContainerMessage(
            "### キャンセルしました\nシークレットは保存されていません。",
            "warning",
          ),
        );
      } else {
        await this.replySubmissionProblem(interaction, outcome);
      }
      return true;
    }

    try {
      await interaction.showModal(createRequestModal(lookup.request));
    } catch (error) {
      this.dependencies.logger?.warn(
        { err: error, event: "secret_request_modal_failed", requestId: parsed.requestId },
        "Failed to open the secret request modal",
      );
      await interaction.reply({
        content: "入力フォームを開けませんでした。時間を置いてもう一度お試しください。",
        flags: MessageFlags.Ephemeral,
      });
    }
    return true;
  }

  async handleModalSubmit(interaction: DiscordSecretModalSubmitInteraction): Promise<boolean> {
    const requestId = parseModalId(interaction.customId);
    if (!requestId) return false;

    const lookup = await this.dependencies.service.lookupPending(requestId);
    if (lookup.kind !== "pending") {
      await interaction.reply(
        createEphemeralTextContainerMessage(
          "### 入力できませんでした\nこのシークレットリクエストは期限切れか、既に処理済みです。",
          "danger",
        ),
      );
      return true;
    }
    if (lookup.request.userId !== interaction.user.id) {
      await interaction.reply(
        createEphemeralTextContainerMessage(
          "### 入力できませんでした\nこのシークレットリクエストを操作できるのは、依頼された本人だけです。",
          "danger",
        ),
      );
      return true;
    }

    const values: Record<string, string> = {};
    try {
      for (const field of lookup.request.fields) {
        values[field.key] = interaction.fields.getTextInputValue(
          createFieldInputId(requestId, field.key),
        );
      }
    } catch {
      await interaction.reply(
        createEphemeralTextContainerMessage(
          "### 入力できませんでした\n入力内容を読み取れませんでした。もう一度入力してください。",
          "danger",
        ),
      );
      return true;
    }

    let outcome: SecretSubmissionOutcome;
    try {
      outcome = await this.dependencies.service.complete(requestId, interaction.user.id, values);
    } catch (error) {
      this.dependencies.logger?.error(
        { err: error, event: "secret_save_failed", requestId },
        "Failed to save a submitted secret",
      );
      await interaction.reply(
        createEphemeralTextContainerMessage(
          "### 保存できませんでした\nシークレットを保存できませんでした。時間を置いてもう一度お試しください。",
          "danger",
        ),
      );
      return true;
    }

    switch (outcome.kind) {
      case "saved":
        await interaction.reply(
          createEphemeralTextContainerMessage(
            "### 保存しました\nシークレットは暗号化して保存されました。このメッセージは他の人には表示されません。",
            "success",
          ),
        );
        await this.updateDirectMessage(
          lookup.request,
          "### 保存しました\nシークレットは暗号化して保存されました。",
          "success",
        );
        return true;
      case "cancelled":
      case "expired":
      case "missing":
        await interaction.reply(
          createEphemeralTextContainerMessage(
            "### 入力できませんでした\nこのシークレットリクエストは期限切れか、既に処理済みです。",
            "danger",
          ),
        );
        await this.updateDirectMessage(
          lookup.request,
          "### 期限切れ\nこのシークレットリクエストは期限切れか、既に処理済みです。",
          "danger",
        );
        return true;
      case "forbidden":
        await interaction.reply(
          createEphemeralTextContainerMessage(
            "### 入力できませんでした\nこのシークレットリクエストを操作できるのは、依頼された本人だけです。",
            "danger",
          ),
        );
        return true;
      case "invalid":
        await interaction.reply(
          createEphemeralTextContainerMessage(
            `### 入力内容を確認してください\n${outcome.message}`,
            "danger",
          ),
        );
        return true;
    }
    throw new Error("Unhandled secret submission outcome.");
  }

  private async replyExpired(interaction: DiscordSecretButtonInteraction): Promise<void> {
    await interaction.reply({
      content: "このシークレットリクエストは期限切れか、既に処理済みです。",
      flags: MessageFlags.Ephemeral,
    });
  }

  private async replySubmissionProblem(
    interaction: DiscordSecretButtonInteraction,
    outcome: SecretSubmissionOutcome,
  ): Promise<void> {
    const message =
      outcome.kind === "forbidden"
        ? "このシークレットリクエストを操作できるのは、依頼された本人だけです。"
        : outcome.kind === "invalid"
          ? outcome.message
          : "このシークレットリクエストは期限切れか、既に処理済みです。";
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }

  private async updateDirectMessage(
    request: SecretRequest,
    text: string,
    tone: DiscordMessageTone,
  ): Promise<void> {
    if (!request.dmChannelId || !request.dmMessageId) return;
    try {
      const channel = await this.dependencies.client.channels.fetch(request.dmChannelId);
      if (!isFetchableMessageChannel(channel)) return;
      const message = await channel.messages.fetch(request.dmMessageId);
      if (!isEditableMessage(message)) return;
      await message.edit(createTextContainerMessage(text, tone));
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "secret_request_dm_update_failed",
          requestId: request.requestId,
          channelId: request.dmChannelId,
          messageId: request.dmMessageId,
        },
        "Failed to update the secret request direct message",
      );
    }
  }
}

function createRequestMessage(request: SecretRequest): DiscordContainerMessage {
  const lines = [
    "### シークレットの入力",
    `<#${request.channelId}> で ${request.label} のシークレットの入力が必要です。`,
    "",
    request.reason,
    "",
    "入力する項目:",
    ...request.fields.map(
      (field) => `- ${field.label}${field.env ? `（環境変数: ${field.env}）` : ""}`,
    ),
    "",
    "入力された内容は暗号化して保存され、会話には表示されません。",
    "心当たりのないリクエストには入力せず、キャンセルしてください。",
    "不要な場合はキャンセルしてください。",
  ];
  const container: ContainerBuilder = createTextContainer(
    lines.join("\n"),
    "warning",
  ).addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(createButtonId("input", request.requestId))
        .setLabel("入力する")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(createButtonId("cancel", request.requestId))
        .setLabel("キャンセル")
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function createRequestModal(request: SecretRequest): ModalBuilder {
  const title = `シークレット: ${normalizeSecretLabel(request.label)}`.slice(0, MODAL_TITLE_LIMIT);
  const modal = new ModalBuilder()
    .setCustomId(`${SECRET_MODAL_PREFIX}:${request.requestId}`)
    .setTitle(title);
  for (const field of request.fields) {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(createFieldInputId(request.requestId, field.key))
          .setLabel(normalizeSecretLabel(field.label).slice(0, MODAL_TITLE_LIMIT))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(4_000),
      ),
    );
  }
  return modal;
}

function createButtonId(action: "input" | "cancel", requestId: string): string {
  return `${SECRET_BUTTON_PREFIX}:${action}:${requestId}`;
}

function parseButtonId(
  customId: string,
): { action: "input" | "cancel"; requestId: string } | undefined {
  const [prefix, action, requestId] = customId.split(":");
  if (prefix !== SECRET_BUTTON_PREFIX || !requestId) return undefined;
  if (action !== "input" && action !== "cancel") return undefined;
  return { action, requestId };
}

function parseModalId(customId: string): string | undefined {
  const [prefix, requestId] = customId.split(":");
  return prefix === SECRET_MODAL_PREFIX && requestId ? requestId : undefined;
}

function createFieldInputId(requestId: string, fieldKey: string): string {
  return `${SECRET_FIELD_PREFIX}:${requestId}:${fieldKey}`;
}

function isSentMessage(value: unknown): value is SendableMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "channelId" in value &&
    typeof value.channelId === "string"
  );
}

function isFetchableMessageChannel(value: unknown): value is FetchableMessageChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    "messages" in value &&
    typeof value.messages === "object" &&
    value.messages !== null &&
    "fetch" in value.messages &&
    typeof value.messages.fetch === "function"
  );
}

function isEditableMessage(value: unknown): value is EditableMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "edit" in value &&
    typeof value.edit === "function"
  );
}
