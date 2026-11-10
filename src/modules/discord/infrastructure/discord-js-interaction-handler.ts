import {
  ActionRowBuilder,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  TextDisplayBuilder,
  type ApplicationCommandDataResolvable,
  type Channel,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";

import type { DiscordOperatingMode } from "../domain/discord-operating-state";
import type { DiscordAccess, DiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";
import type { DiscordChannelRuleStore } from "../ports/discord-channel-rule-store";
import { DiscordVoiceChatController, VOICE_COMMAND } from "./discord-voice-chat-controller";

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
const CHANNEL_RULE_MODAL_ID = "channel-rule-edit";
const CHANNEL_RULE_INPUT_ID = "channel-rule";
const CONTAINER_TEXT_LIMIT = 4_000;
const ACCESS_LABELS: Readonly<Record<DiscordAccess, string>> = {
  allow: "許可",
  deny: "拒否",
  owner: "オーナーのみ",
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

async function fetchChannelName(client: Client, channelId: string): Promise<string | undefined> {
  const cached = client.channels.cache.get(channelId);
  const channel = cached ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel) return undefined;
  return "name" in channel && typeof channel.name === "string" && channel.name
    ? channel.name
    : undefined;
}

function truncateText(lines: readonly string[], limit: number): string {
  let text = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const candidate = text ? `${text}\n${line}` : line;
    if (candidate.length > limit) {
      const remaining = lines.length - index;
      return `${text}\n…ほか ${remaining} 件`;
    }
    text = candidate;
  }
  return text;
}

export class DiscordJsInteractionHandler {
  readonly commands: readonly ApplicationCommandDataResolvable[];

  constructor(
    private readonly accessPolicy: DiscordAccessPolicy,
    private readonly setOperatingMode: (mode: DiscordOperatingMode) => void,
    private readonly voiceChatController?: DiscordVoiceChatController,
    private readonly channelRuleStore?: DiscordChannelRuleStore,
    private readonly accessRuleStore?: DiscordAccessRuleStore,
  ) {
    this.commands = [
      OPERATING_MODE_COMMAND,
      CHANNEL_RULE_COMMAND,
      ALLOWED_CHANNELS_COMMAND,
      ...(voiceChatController ? [VOICE_COMMAND] : []),
    ];
  }

  async handle(interaction: Interaction): Promise<void> {
    if (interaction.isModalSubmit()) {
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
    if (!interaction.isChatInputCommand()) return;
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
    const mode =
      subcommand === "idle"
        ? ("paused" as const)
        : subcommand === "online"
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
      components: [
        new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            mode === "active" ? "Botを再開しました。" : "Botを一時停止しました。",
          ),
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  private async canUseCommandsInChannel(
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  ): Promise<boolean> {
    const channelId = interaction.channelId;
    if (!channelId) return false;

    let channel: Channel | null = interaction.channel;
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

  private async listAllowedChannels(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const guildRule = this.accessRuleStore?.getGuildRule(guildId);
    const resolve = (target: { channelId: string; threadId?: string }): DiscordAccess =>
      this.accessPolicy.resolveAccess({
        guildId,
        userId: interaction.user.id,
        userIsBot: interaction.user.bot,
        ...target,
      });

    const lines: string[] = ["### 許可されたチャンネルとスレッド"];
    if (guildRule?.access) {
      lines.push(`ギルド全体: ${ACCESS_LABELS[guildRule.access]}`);
    }

    let listed = 0;
    for (const [channelId, channelRule] of Object.entries(guildRule?.channels ?? {})) {
      const channelAccess = resolve({ channelId });
      const channelAllowed = channelAccess !== "deny";
      const channelName = await fetchChannelName(interaction.client, channelId);
      const channelReference = channelName ? `#${channelName}` : channelId;
      if (channelAllowed) {
        lines.push(`・${channelReference}（${ACCESS_LABELS[channelAccess]}）`);
        listed += 1;
      }

      for (const threadId of Object.keys(channelRule.threads ?? {})) {
        const threadAccess = resolve({ channelId, threadId });
        if (threadAccess === "deny") continue;
        const threadName = await fetchChannelName(interaction.client, threadId);
        const threadReference = threadName ? `#${threadName}` : threadId;
        lines.push(
          channelAllowed
            ? `　└ ${threadReference}（${ACCESS_LABELS[threadAccess]}）`
            : `・${channelReference} / ${threadReference}（${ACCESS_LABELS[threadAccess]}）`,
        );
        listed += 1;
      }
    }

    if (listed === 0) {
      lines.push(
        guildRule?.access === "deny" || !guildRule
          ? "明示的に許可されたチャンネルやスレッドはありません。"
          : "個別に許可されたチャンネルやスレッドはありません。",
      );
    }

    await interaction.reply({
      components: [
        new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(truncateText(lines, CONTAINER_TEXT_LIMIT)),
        ),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }

  private async openChannelRuleEditor(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.UseApplicationCommands)) {
      await interaction.reply({
        content: "このコマンドを実行する権限がありません。",
      });
      return;
    }

    const existingRule = await this.channelRuleStore?.get(
      interaction.guildId,
      interaction.channelId,
    );
    const { modalId, inputId } = createChannelRuleComponentIds(interaction.id);
    const input = new TextInputBuilder()
      .setCustomId(inputId)
      .setLabel("この場所のルール")
      .setPlaceholder("このチャンネル／スレッドで守るルール")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(4_000);
    if (existingRule) input.setValue(existingRule);

    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle("ルールを編集（空欄で削除）")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
  }

  private async saveChannelRule(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "この操作はサーバー内でのみ使用できます。",
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.UseApplicationCommands)) {
      await interaction.reply({
        content: "この操作を実行する権限がありません。",
      });
      return;
    }

    const rule = interaction.fields.getTextInputValue(
      interaction.customId.replace(`${CHANNEL_RULE_MODAL_ID}:`, `${CHANNEL_RULE_INPUT_ID}:`),
    );
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (!guildId || !channelId) {
      await interaction.reply({
        content: "チャンネルを特定できませんでした。",
      });
      return;
    }

    await this.channelRuleStore?.set(guildId, channelId, rule);
    await interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(rule.trim() ? 0x57f287 : 0x747f8d)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              rule.trim()
                ? "このチャンネル／スレッドのルールを保存しました。"
                : "このチャンネル／スレッドのルールを削除しました。",
            ),
          ),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
}
