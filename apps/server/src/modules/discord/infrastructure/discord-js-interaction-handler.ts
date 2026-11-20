import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ApplicationCommandDataResolvable,
  type InteractionReplyOptions,
} from "discord.js";

import { buildAllowedDiscordChannelLines } from "../application/discord-channel-list";
import {
  DiscordChannelRuleCommand,
  type DiscordChannelRuleCommandRejection,
} from "../application/discord-channel-rule-command";
import {
  decideDiscordOperatingModeCommand,
  type DiscordOperatingModeCommandRejection,
} from "../application/discord-operating-mode-command";
import type { DiscordOperatingMode } from "../domain/discord-operating-state";
import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";
import type { DiscordChannelRuleStore } from "../ports/discord-channel-rule-store";
import {
  createEphemeralTextContainerMessage,
  createTextContainer,
  createTextContainerMessage,
  truncateTextLines,
} from "./discord-component-message";
import type { DiscordChannelLink, DiscordChannelLinkTarget } from "../domain/discord-channel-link";
import type { DiscordChannelLinkCommandInteraction } from "./discord-channel-link-requester";
import {
  DiscordVoiceChatController,
  VOICE_COMMAND,
  type VoiceChatCommandInteraction,
} from "./discord-voice-chat-controller";

const OPERATING_MODE_COMMAND = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Botの稼働状態を変更します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((subcommand) => subcommand.setName("idle").setDescription("Botを一時停止します"))
  .addSubcommand((subcommand) => subcommand.setName("online").setDescription("Botを再開します"));
const CHANNEL_RULE_COMMAND = new SlashCommandBuilder()
  .setName("rule")
  .setDescription("このチャンネルまたはスレッドのルールを編集します")
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setDMPermission(false);
const ALLOWED_CHANNELS_COMMAND = new SlashCommandBuilder()
  .setName("channels")
  .setDescription("このサーバーで明示的に許可されたチャンネルとスレッドを表示します")
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setDMPermission(false);
const CHANNEL_LINK_COMMAND = new SlashCommandBuilder()
  .setName("link")
  .setDescription("この場所をあなたのチャンネルとしてオーナーに登録してもらいます")
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setDMPermission(false);
const CHANNEL_UNLINK_COMMAND = new SlashCommandBuilder()
  .setName("unlink")
  .setDescription("この場所のユーザーリンクを解除します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);
const CHANNEL_RULE_MODAL_ID = "channel-rule-edit";
const CHANNEL_RULE_INPUT_ID = "channel-rule";
const OPERATING_MODE_REJECTION_MESSAGES: Readonly<
  Record<DiscordOperatingModeCommandRejection, string>
> = {
  "guild-only": "このコマンドはサーバー内でのみ使用できます。",
  "missing-permission": "このコマンドを実行する権限がありません。",
};
const RULE_EDIT_REJECTION_MESSAGES: Readonly<Record<DiscordChannelRuleCommandRejection, string>> = {
  "guild-only": "このコマンドはサーバー内でのみ使用できます。",
  "missing-permission": "このコマンドを実行する権限がありません。",
  "unknown-channel": "チャンネルを特定できませんでした。",
};
const RULE_SUBMIT_REJECTION_MESSAGES: Readonly<Record<DiscordChannelRuleCommandRejection, string>> =
  {
    "guild-only": "この操作はサーバー内でのみ使用できます。",
    "missing-permission": "この操作を実行する権限がありません。",
    "unknown-channel": "チャンネルを特定できませんでした。",
  };

/**
 * Discord clients cache modal input values per custom id, even across channels and bots, until the
 * modal is submitted. Reusing a fixed id would show a rule from another channel after the modal was
 * dismissed, so every open gets its own id.
 */
function createChannelRuleComponentIds(nonce: string): { modalId: string; inputId: string } {
  return {
    modalId: `${CHANNEL_RULE_MODAL_ID}:${nonce}`,
    inputId: `${CHANNEL_RULE_INPUT_ID}:${nonce}`,
  };
}

export interface DiscordInteractionChannel {
  readonly id: string;
  readonly name?: string | null;
  readonly parentId?: string | null;
  isThread(): boolean;
}

export interface DiscordInteractionClient {
  readonly channels: {
    readonly cache: { get(id: string): DiscordInteractionChannel | undefined };
    fetch(id: string): Promise<DiscordInteractionChannel | null>;
  };
}

export interface DiscordChatInputInteraction extends VoiceChatCommandInteraction {
  readonly id: string;
  readonly commandName: string;
  readonly client: DiscordInteractionClient;
  readonly memberPermissions: { has(permission: bigint): boolean } | null;
  isChatInputCommand(): boolean;
  isModalSubmit(): boolean;
  reply(options: InteractionReplyOptions): Promise<unknown>;
  editReply(options: string | InteractionReplyOptions): Promise<unknown>;
  showModal(modal: ModalBuilder): Promise<unknown>;
  deleteReply(): Promise<void>;
}

export interface DiscordModalSubmitInteraction {
  readonly id: string;
  readonly customId: string;
  readonly guildId: string | null;
  readonly channelId: string | null;
  readonly channel: DiscordInteractionChannel | null;
  readonly client: DiscordInteractionClient;
  readonly user: { readonly id: string; readonly bot: boolean };
  readonly memberPermissions: { has(permission: bigint): boolean } | null;
  readonly fields: { getTextInputValue(customId: string): string };
  inGuild(): boolean;
  isChatInputCommand(): boolean;
  isModalSubmit(): boolean;
  reply(options: InteractionReplyOptions): Promise<unknown>;
}

export interface DiscordOtherInteraction {
  isChatInputCommand(): boolean;
  isModalSubmit(): boolean;
}

export interface DiscordChannelLinkCommand {
  requestFromInteraction(interaction: DiscordChannelLinkCommandInteraction): Promise<void>;
  unlinkFromInteraction(interaction: DiscordChannelLinkCommandInteraction): Promise<void>;
  getLink(target: DiscordChannelLinkTarget): DiscordChannelLink | undefined;
  listLinks(guildId: string): readonly DiscordChannelLink[];
}

export type DiscordHandlerInteraction =
  DiscordChatInputInteraction | DiscordModalSubmitInteraction | DiscordOtherInteraction;

function isModalSubmit(
  interaction: DiscordHandlerInteraction,
): interaction is DiscordModalSubmitInteraction {
  return interaction.isModalSubmit() && "customId" in interaction && "fields" in interaction;
}

function isChatInputCommand(
  interaction: DiscordHandlerInteraction,
): interaction is DiscordChatInputInteraction {
  return (
    interaction.isChatInputCommand() && "commandName" in interaction && "options" in interaction
  );
}

async function fetchChannelName(
  client: DiscordInteractionClient,
  channelId: string,
): Promise<string | undefined> {
  const cached = client.channels.cache.get(channelId);
  const channel = cached ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel) return undefined;
  return "name" in channel && typeof channel.name === "string" && channel.name
    ? channel.name
    : undefined;
}

export class DiscordJsInteractionHandler {
  readonly commands: readonly ApplicationCommandDataResolvable[];
  private readonly channelRuleCommand: DiscordChannelRuleCommand;

  constructor(
    private readonly accessPolicy: DiscordAccessPolicy,
    private readonly setOperatingMode: (mode: DiscordOperatingMode) => void,
    private readonly voiceChatController?: DiscordVoiceChatController,
    channelRuleStore?: DiscordChannelRuleStore,
    private readonly accessRuleStore?: DiscordAccessRuleStore,
    private readonly channelLink?: DiscordChannelLinkCommand,
  ) {
    this.channelRuleCommand = new DiscordChannelRuleCommand(channelRuleStore);
    this.commands = [
      OPERATING_MODE_COMMAND,
      CHANNEL_RULE_COMMAND,
      ALLOWED_CHANNELS_COMMAND,
      CHANNEL_LINK_COMMAND,
      CHANNEL_UNLINK_COMMAND,
      ...(voiceChatController ? [VOICE_COMMAND] : []),
    ];
  }

  async handle(interaction: DiscordHandlerInteraction): Promise<void> {
    if (isModalSubmit(interaction)) {
      if (!interaction.customId.startsWith(`${CHANNEL_RULE_MODAL_ID}:`)) return;
      if (!(await this.canUseCommandsInChannel(interaction))) {
        await interaction.reply({
          content: "このチャンネルではコマンドを利用できません。",
          ephemeral: true,
        });
        return;
      }
      await this.saveChannelRule(interaction);
      return;
    }
    if (!isChatInputCommand(interaction)) return;
    if (interaction.commandName === "link" || interaction.commandName === "unlink") {
      if (!this.channelLink) {
        await interaction.reply(
          createEphemeralTextContainerMessage("チャンネルのリンク操作は無効です。", "danger"),
        );
        return;
      }
      if (interaction.commandName === "link") {
        await this.channelLink.requestFromInteraction(interaction);
      } else {
        await this.channelLink.unlinkFromInteraction(interaction);
      }
      return;
    }
    if (!(await this.canUseCommandsInChannel(interaction))) {
      await interaction.reply({
        content: "このチャンネルではコマンドを利用できません。",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "rule") {
      await this.openChannelRuleEditor(interaction);
      return;
    }

    if (interaction.commandName === "channels") {
      await this.listAllowedChannels(interaction);
      return;
    }

    if (interaction.commandName === "voice") {
      if (this.voiceChatController) {
        await this.voiceChatController.handleCommand(interaction);
      } else {
        await interaction.reply({
          content: interaction.inGuild()
            ? "VC会話は無効です。"
            : "このコマンドはサーバー内でのみ使用できます。",
          ephemeral: true,
        });
      }
      return;
    }

    const subcommand =
      interaction.commandName === "status" ? interaction.options.getSubcommand() : undefined;
    if (subcommand === undefined) return;

    const result = decideDiscordOperatingModeCommand({
      subcommand,
      inGuild: interaction.inGuild(),
      canManageGuild: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    });
    switch (result.kind) {
      case "ignored":
        return;
      case "rejected":
        await interaction.reply({
          content: OPERATING_MODE_REJECTION_MESSAGES[result.reason],
          ephemeral: true,
        });
        return;
      case "changed":
        this.setOperatingMode(result.mode);
        await interaction.reply(
          createTextContainerMessage(
            result.mode === "active" ? "Botを再開しました。" : "Botを一時停止しました。",
          ),
        );
        return;
    }
  }

  private async canUseCommandsInChannel(
    interaction: DiscordChatInputInteraction | DiscordModalSubmitInteraction,
  ): Promise<boolean> {
    const channelId = interaction.channelId;
    if (!channelId) return false;

    let channel: DiscordInteractionChannel | null = interaction.channel;
    if (!channel && interaction.inGuild()) {
      channel = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (!channel) return false;
    }

    const thread = channel?.isThread() ? channel : undefined;
    return this.accessPolicy.canReceive({
      guildId: interaction.guildId ?? undefined,
      channelId: thread?.parentId ?? channelId,
      threadId: thread?.id,
      userId: interaction.user.id,
      userIsBot: interaction.user.bot,
    });
  }

  private async listAllowedChannels(interaction: DiscordChatInputInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const lines = await buildAllowedDiscordChannelLines(
      {
        guildId,
        userId: interaction.user.id,
        userIsBot: interaction.user.bot,
      },
      {
        getGuildRule: (id) => this.accessRuleStore?.getGuildRule(id),
        resolveAccess: (target) => this.accessPolicy.resolveAccess(target),
        resolveChannelName: (id) => fetchChannelName(interaction.client, id),
        resolveChannelOwner: (target) => this.channelLink?.getLink({ guildId, ...target })?.userId,
        listChannelLinks: (id) => this.channelLink?.listLinks(id) ?? [],
      },
    );

    await interaction.reply({
      components: [createTextContainer(truncateTextLines(lines))],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }

  private async openChannelRuleEditor(interaction: DiscordChatInputInteraction): Promise<void> {
    const result = await this.channelRuleCommand.getRuleForEdit({
      inGuild: interaction.inGuild(),
      canUseApplicationCommands:
        interaction.memberPermissions?.has(PermissionFlagsBits.UseApplicationCommands) ?? false,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
    });
    if (result.kind === "rejected") {
      await interaction.reply({ content: RULE_EDIT_REJECTION_MESSAGES[result.reason] });
      return;
    }

    const { modalId, inputId } = createChannelRuleComponentIds(interaction.id);
    const input = new TextInputBuilder()
      .setCustomId(inputId)
      .setLabel("この場所のルール")
      .setPlaceholder("このチャンネル／スレッドで守るルール")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(4_000);
    if (result.rule) input.setValue(result.rule);

    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle("ルールを編集（空欄で削除）")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
  }

  private async saveChannelRule(interaction: DiscordModalSubmitInteraction): Promise<void> {
    const rule = interaction.fields.getTextInputValue(
      interaction.customId.replace(`${CHANNEL_RULE_MODAL_ID}:`, `${CHANNEL_RULE_INPUT_ID}:`),
    );
    const result = await this.channelRuleCommand.applyRuleEdit(
      {
        inGuild: interaction.inGuild(),
        canUseApplicationCommands:
          interaction.memberPermissions?.has(PermissionFlagsBits.UseApplicationCommands) ?? false,
        guildId: interaction.guildId ?? undefined,
        channelId: interaction.channelId ?? undefined,
      },
      rule,
    );
    if (result.kind === "rejected") {
      await interaction.reply({ content: RULE_SUBMIT_REJECTION_MESSAGES[result.reason] });
      return;
    }

    await interaction.reply(
      createTextContainerMessage(
        result.kind === "saved"
          ? "このチャンネル／スレッドのルールを保存しました。"
          : "このチャンネル／スレッドのルールを削除しました。",
        result.kind === "saved" ? "success" : "neutral",
      ),
    );
  }
}
