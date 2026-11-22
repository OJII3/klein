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
  AuthCredentialControl,
  AuthRequestOutcome,
  AuthSubmissionOutcome,
} from "../application/auth-credential-service";
import type { AuthRequest, AuthRequestDraft } from "../domain/auth-request";
import { normalizeAuthLabel } from "../domain/auth-credential";
import {
  createEphemeralTextContainerMessage,
  createTextContainer,
  createTextContainerMessage,
  type DiscordContainerMessage,
  type DiscordEphemeralContainerMessage,
  type DiscordMessageTone,
} from "../../discord/infrastructure/discord-component-message";

const AUTH_BUTTON_PREFIX = "klein-auth";
const AUTH_MODAL_PREFIX = "klein-auth-modal";
const AUTH_FIELD_PREFIX = "klein-auth-field";

const MODAL_TITLE_LIMIT = 45;

export interface DiscordAuthButtonInteraction {
  readonly customId: string;
  readonly user: { readonly id: string };
  reply(options: { content: string; flags: MessageFlags.Ephemeral }): Promise<unknown>;
  update(options: DiscordContainerMessage): Promise<unknown>;
  showModal(modal: ModalBuilder): Promise<unknown>;
}

export interface DiscordAuthModalSubmitInteraction {
  readonly customId: string;
  readonly user: { readonly id: string };
  readonly fields: { getTextInputValue(customId: string): string };
  reply(options: DiscordEphemeralContainerMessage): Promise<unknown>;
}

export interface DiscordAuthClient {
  readonly channels: { fetch(id: string): Promise<unknown> };
  readonly users: {
    fetch(id: string): Promise<{
      send(payload: DiscordContainerMessage): Promise<unknown>;
    }>;
  };
}

export interface DiscordAuthCredentialRequesterDependencies {
  readonly client: DiscordAuthClient;
  readonly service: AuthCredentialControl;
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
 * Presents a worker's credential request in the linked user's direct messages.
 * A button opens a modal, and only the modal submit carries the values. The
 * values never pass through the conversation channel or the model.
 */
export class DiscordAuthCredentialRequester {
  constructor(private readonly dependencies: DiscordAuthCredentialRequesterDependencies) {}

  async request(draft: AuthRequestDraft): Promise<AuthRequestOutcome> {
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
          event: "auth_request_dm_failed",
          userId: outcome.request.userId,
          requestId: outcome.request.requestId,
        },
        "Failed to send an auth request by direct message",
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
            event: "auth_request_message_attach_failed",
            requestId: outcome.request.requestId,
          },
          "Failed to remember the auth request direct message",
        );
      }
    }
    return outcome;
  }

  async handleButton(interaction: DiscordAuthButtonInteraction): Promise<boolean> {
    const parsed = parseButtonId(interaction.customId);
    if (!parsed) return false;

    const lookup = await this.dependencies.service.lookupPending(parsed.requestId);
    if (lookup.kind !== "pending") {
      await this.replyExpired(interaction);
      return true;
    }
    if (lookup.request.userId !== interaction.user.id) {
      await interaction.reply({
        content: "この認証リクエストを操作できるのは、依頼された本人だけです。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (parsed.action === "cancel") {
      const outcome = await this.dependencies.service.cancel(parsed.requestId, interaction.user.id);
      if (outcome.kind === "cancelled") {
        await interaction.update(
          createTextContainerMessage(
            "### キャンセルしました\n認証情報は保存されていません。",
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
        { err: error, event: "auth_request_modal_failed", requestId: parsed.requestId },
        "Failed to open the auth request modal",
      );
      await interaction.reply({
        content: "入力フォームを開けませんでした。時間を置いてもう一度お試しください。",
        flags: MessageFlags.Ephemeral,
      });
    }
    return true;
  }

  async handleModalSubmit(interaction: DiscordAuthModalSubmitInteraction): Promise<boolean> {
    const requestId = parseModalId(interaction.customId);
    if (!requestId) return false;

    const lookup = await this.dependencies.service.lookupPending(requestId);
    if (lookup.kind !== "pending") {
      await interaction.reply(
        createEphemeralTextContainerMessage(
          "### 入力できませんでした\nこの認証リクエストは期限切れか、既に処理済みです。",
          "danger",
        ),
      );
      return true;
    }
    if (lookup.request.userId !== interaction.user.id) {
      await interaction.reply(
        createEphemeralTextContainerMessage(
          "### 入力できませんでした\nこの認証リクエストを操作できるのは、依頼された本人だけです。",
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

    let outcome: AuthSubmissionOutcome;
    try {
      outcome = await this.dependencies.service.complete(requestId, interaction.user.id, values);
    } catch (error) {
      this.dependencies.logger?.error(
        { err: error, event: "auth_credential_save_failed", requestId },
        "Failed to save a submitted credential",
      );
      await interaction.reply(
        createEphemeralTextContainerMessage(
          "### 保存できませんでした\n認証情報を保存できませんでした。時間を置いてもう一度お試しください。",
          "danger",
        ),
      );
      return true;
    }

    switch (outcome.kind) {
      case "saved":
        await interaction.reply(
          createEphemeralTextContainerMessage(
            "### 保存しました\n認証情報は暗号化して保存されました。このメッセージは他の人には表示されません。",
            "success",
          ),
        );
        await this.updateDirectMessage(
          lookup.request,
          "### 保存しました\n認証情報は暗号化して保存されました。",
          "success",
        );
        return true;
      case "cancelled":
      case "expired":
      case "missing":
        await interaction.reply(
          createEphemeralTextContainerMessage(
            "### 入力できませんでした\nこの認証リクエストは期限切れか、既に処理済みです。",
            "danger",
          ),
        );
        await this.updateDirectMessage(
          lookup.request,
          "### 期限切れ\nこの認証リクエストは期限切れか、既に処理済みです。",
          "danger",
        );
        return true;
      case "forbidden":
        await interaction.reply(
          createEphemeralTextContainerMessage(
            "### 入力できませんでした\nこの認証リクエストを操作できるのは、依頼された本人だけです。",
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
    throw new Error("Unhandled auth submission outcome.");
  }

  private async replyExpired(interaction: DiscordAuthButtonInteraction): Promise<void> {
    await interaction.reply({
      content: "この認証リクエストは期限切れか、既に処理済みです。",
      flags: MessageFlags.Ephemeral,
    });
  }

  private async replySubmissionProblem(
    interaction: DiscordAuthButtonInteraction,
    outcome: AuthSubmissionOutcome,
  ): Promise<void> {
    const message =
      outcome.kind === "forbidden"
        ? "この認証リクエストを操作できるのは、依頼された本人だけです。"
        : outcome.kind === "invalid"
          ? outcome.message
          : "この認証リクエストは期限切れか、既に処理済みです。";
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }

  private async updateDirectMessage(
    request: AuthRequest,
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
          event: "auth_request_dm_update_failed",
          requestId: request.requestId,
          channelId: request.dmChannelId,
          messageId: request.dmMessageId,
        },
        "Failed to update the auth request direct message",
      );
    }
  }
}

function createRequestMessage(request: AuthRequest): DiscordContainerMessage {
  const lines = [
    "### 認証情報の入力",
    `<#${request.channelId}> で ${request.label} の認証が必要です。`,
    "",
    request.reason,
    "",
    "入力する項目:",
    ...request.fields.map((field) => `- ${field.label}`),
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

function createRequestModal(request: AuthRequest): ModalBuilder {
  const title = `認証情報: ${normalizeAuthLabel(request.label)}`.slice(0, MODAL_TITLE_LIMIT);
  const modal = new ModalBuilder()
    .setCustomId(`${AUTH_MODAL_PREFIX}:${request.requestId}`)
    .setTitle(title);
  for (const field of request.fields) {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(createFieldInputId(request.requestId, field.key))
          .setLabel(normalizeAuthLabel(field.label).slice(0, MODAL_TITLE_LIMIT))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(4_000),
      ),
    );
  }
  return modal;
}

function createButtonId(action: "input" | "cancel", requestId: string): string {
  return `${AUTH_BUTTON_PREFIX}:${action}:${requestId}`;
}

function parseButtonId(
  customId: string,
): { action: "input" | "cancel"; requestId: string } | undefined {
  const [prefix, action, requestId] = customId.split(":");
  if (prefix !== AUTH_BUTTON_PREFIX || !requestId) return undefined;
  if (action !== "input" && action !== "cancel") return undefined;
  return { action, requestId };
}

function parseModalId(customId: string): string | undefined {
  const [prefix, requestId] = customId.split(":");
  return prefix === AUTH_MODAL_PREFIX && requestId ? requestId : undefined;
}

function createFieldInputId(requestId: string, fieldKey: string): string {
  return `${AUTH_FIELD_PREFIX}:${requestId}:${fieldKey}`;
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
