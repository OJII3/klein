import type { Logger } from "pino";
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { AsrClient } from "@modules/asr/domain/asr-client";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import type {
  VoiceChatConversation,
  VoiceChatConversationFactory,
} from "../ports/voice-chat-conversation";
import { DiscordVoiceCaptureSession } from "./discord-voice-capture-session";

export const VOICE_COMMAND = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("VC音声を使った会話を開始・終了します")
  .addSubcommand((command) => command.setName("join").setDescription("VCに参加して会話を開始"))
  .addSubcommand((command) => command.setName("leave").setDescription("VCから退出して会話を終了"))
  .toJSON();

export interface DiscordVoiceChatControllerOptions {
  readonly asr: AsrClient;
  readonly conversationFactory: VoiceChatConversationFactory;
  readonly language: string;
}

interface ActiveVoiceChat {
  readonly conversation: VoiceChatConversation;
  readonly session: DiscordVoiceCaptureSession;
  readonly userId: string;
}

interface SendableChannel {
  send(content: string): Promise<unknown>;
}

function isSendableChannel(value: unknown): value is SendableChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof value.send === "function"
  );
}

export class DiscordVoiceChatController {
  private readonly sessions = new Map<string, ActiveVoiceChat>();
  private readonly logger?: Logger;

  constructor(
    private readonly accessPolicy: DiscordAccessPolicy,
    logger: Logger | undefined,
    private readonly options: DiscordVoiceChatControllerOptions,
  ) {
    this.logger = logger?.child({ component: "discord-voice-chat-controller" });
  }

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        ephemeral: true,
      });
      return;
    }

    const guildId = interaction.guildId;
    if (interaction.options.getSubcommand() === "leave") {
      await this.leave(interaction, guildId);
      return;
    }

    if (this.sessions.has(guildId)) {
      await interaction.reply({
        content: "このサーバーでは既にVC会話中です。",
        ephemeral: true,
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) return;
    const member = await guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: "先にVCへ参加してください。", ephemeral: true });
      return;
    }
    if (!interaction.channel || !isSendableChannel(interaction.channel)) {
      await interaction.reply({ content: "VC会話の投稿先を取得できません。", ephemeral: true });
      return;
    }

    const textThread = interaction.channel.isThread() ? interaction.channel : undefined;
    const textChannelId = textThread?.parentId ?? interaction.channelId;
    if (
      !this.accessPolicy.canReceive({
        guildId,
        channelId: textChannelId,
        threadId: textThread?.id,
      })
    ) {
      await interaction.reply({
        content: "このチャンネルではVC会話を利用できません。",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    let conversation: VoiceChatConversation | undefined;
    let session: DiscordVoiceCaptureSession | undefined;
    try {
      const createdConversation = await this.options.conversationFactory.create({
        channelId: interaction.channelId,
        guildId,
        parentChannelId: textThread?.parentId ?? undefined,
        threadId: textThread?.id,
        user: {
          bot: false,
          displayName: member.displayName,
          id: interaction.user.id,
          username: member.user.username,
        },
        voiceChannelId: voiceChannel.id,
      });
      conversation = createdConversation;
      session = new DiscordVoiceCaptureSession({
        adapterCreator: guild.voiceAdapterCreator,
        asr: this.options.asr,
        guildId,
        language: this.options.language,
        logger: this.logger,
        onError: (error) => {
          if (this.sessions.get(guildId)?.session !== session) return;
          this.sessions.delete(guildId);
          void session?.stop();
          this.logger?.warn(
            { err: error, event: "discord_voice_chat_session_ended", guildId },
            "Stopped the voice conversation after an ASR failure",
          );
          void createdConversation.stop().catch((stopError: unknown) => {
            this.logger?.warn(
              { err: stopError, event: "discord_voice_chat_cleanup_failed", guildId },
              "Failed to clean up the voice conversation after an ASR failure",
            );
          });
        },
        onTranscript: (text) => createdConversation.handleTranscript(text),
        userId: interaction.user.id,
        voiceChannelId: voiceChannel.id,
      });
      this.sessions.set(guildId, { conversation, session, userId: interaction.user.id });
      await session.start();
      await interaction.editReply("VCに参加しました。発話を会話セッションに送ります。");
    } catch (error) {
      this.sessions.delete(guildId);
      await Promise.allSettled([session?.stop(), conversation?.stop()]);
      this.logger?.warn(
        { err: error, event: "discord_voice_chat_start_failed", guildId },
        "Failed to start Discord voice chat",
      );
      await interaction.editReply(
        "VC会話を開始できませんでした。設定とASRサーバーを確認してください。",
      );
    }
  }

  async stop(): Promise<void> {
    const activeSessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      activeSessions.map(({ conversation, session }) =>
        Promise.all([session.stop(), conversation.stop()]),
      ),
    );
  }

  private async leave(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
    const active = this.sessions.get(guildId);
    if (!active) {
      await interaction.reply({ content: "VC会話セッションはありません。", ephemeral: true });
      return;
    }
    if (active.userId !== interaction.user.id) {
      await interaction.reply({
        content: "開始したユーザーだけが終了できます。",
        ephemeral: true,
      });
      return;
    }

    this.sessions.delete(guildId);
    await Promise.all([active.session.stop(), active.conversation.stop()]);
    await interaction.reply({ content: "VCから退出しました。", ephemeral: true });
  }
}
