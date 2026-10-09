import {
  ActionRowBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ApplicationCommandDataResolvable,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";

import type { DiscordOperatingMode } from "../domain/discord-operating-state";
import type { DiscordChannelRuleStore } from "../ports/discord-channel-rule-store";
import { DiscordVoiceChatController, VOICE_COMMAND } from "./discord-voice-chat-controller";

const OPERATING_MODE_COMMANDS: readonly ApplicationCommandDataResolvable[] = [
  {
    name: "idle",
    description: "Botを一時停止します",
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    dmPermission: false,
  },
  {
    name: "online",
    description: "Botを再開します",
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    dmPermission: false,
  },
];
const CHANNEL_RULE_COMMAND = new SlashCommandBuilder()
  .setName("rule")
  .setDescription("このチャンネルまたはスレッドのルールを編集します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);
const CHANNEL_RULE_MODAL_ID = "channel-rule-edit";
const CHANNEL_RULE_INPUT_ID = "channel-rule";

export class DiscordJsInteractionHandler {
  readonly commands: readonly ApplicationCommandDataResolvable[];

  constructor(
    private readonly setOperatingMode: (mode: DiscordOperatingMode) => void,
    private readonly voiceChatController?: DiscordVoiceChatController,
    private readonly channelRuleStore?: DiscordChannelRuleStore,
  ) {
    this.commands = [
      ...OPERATING_MODE_COMMANDS,
      CHANNEL_RULE_COMMAND,
      ...(voiceChatController ? [VOICE_COMMAND] : []),
    ];
  }

  async handle(interaction: Interaction): Promise<void> {
    if (interaction.isModalSubmit()) {
      if (interaction.customId === CHANNEL_RULE_MODAL_ID) {
        await this.saveChannelRule(interaction);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "rule") {
      await this.openChannelRuleEditor(interaction);
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

    const mode =
      interaction.commandName === "idle"
        ? ("paused" as const)
        : interaction.commandName === "online"
          ? ("active" as const)
          : undefined;
    if (!mode) return;

    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        ephemeral: true,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "このコマンドを実行する権限がありません。",
        ephemeral: true,
      });
      return;
    }

    this.setOperatingMode(mode);
    await interaction.reply({
      content: mode === "active" ? "Botを再開しました。" : "Botを一時停止しました。",
      ephemeral: true,
    });
  }

  private async openChannelRuleEditor(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        ephemeral: true,
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "このコマンドを実行する権限がありません。",
        ephemeral: true,
      });
      return;
    }

    const existingRule = await this.channelRuleStore?.get(
      interaction.guildId,
      interaction.channelId,
    );
    const input = new TextInputBuilder()
      .setCustomId(CHANNEL_RULE_INPUT_ID)
      .setLabel("この場所のルール")
      .setPlaceholder("このチャンネル／スレッドで守るルール")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(4_000);
    if (existingRule) input.setValue(existingRule);

    const modal = new ModalBuilder()
      .setCustomId(CHANNEL_RULE_MODAL_ID)
      .setTitle("ルールを編集（空欄で削除）")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
  }

  private async saveChannelRule(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "この操作はサーバー内でのみ使用できます。",
        ephemeral: true,
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "この操作を実行する権限がありません。",
        ephemeral: true,
      });
      return;
    }

    const rule = interaction.fields.getTextInputValue(CHANNEL_RULE_INPUT_ID);
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (!guildId || !channelId) {
      await interaction.reply({
        content: "チャンネルを特定できませんでした。",
        ephemeral: true,
      });
      return;
    }

    await this.channelRuleStore?.set(guildId, channelId, rule);
    await interaction.reply({
      content: rule.trim()
        ? "このチャンネル／スレッドのルールを保存しました。"
        : "このチャンネル／スレッドのルールを削除しました。",
      ephemeral: true,
    });
  }
}
