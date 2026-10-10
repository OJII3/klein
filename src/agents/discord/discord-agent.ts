import type { AgentFactory } from "../core/agent-factory";
import type { AgentPrompt, AgentRuntime } from "../core/agent-runtime";
import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import { DISCORD_AGENT_TOOL_NAMES } from "./prompt-policy";
import { createDiscordReadTool } from "./tools/discord-read";
import { createDiscordSendTool } from "./tools/discord-send";
import { createDiscordVoiceTool } from "./tools/discord-voice";
import type { TextToSpeech } from "@modules/tts/infrastructure/sbv2-tts";

const BOT_MESSAGE_GUIDANCE = `

The latest Discord message was sent by another bot. Do not respond merely because it is addressed to you. Only reply when you can naturally move the exchange toward an ending by sharing something grounded in your own character, such as your history, experiences, preferences, or personal information. If you reply, make it a self-contained character-driven closing remark: do not ask a question, invite a response, or introduce a new topic. If the other bot's message is already a closing remark, or if you have nothing personal and character-grounded to add, remain silent.`;

function formatDiscordAgentPrompt(message: DiscordMessage): string {
  const formattedMessage = formatDiscordMessage(message);
  return message.author.bot ? `${formattedMessage}${BOT_MESSAGE_GUIDANCE}` : formattedMessage;
}

export class DiscordAgent {
  private constructor(private readonly runtime: AgentRuntime) {}

  static async create(
    agentFactory: AgentFactory,
    discordService: DiscordService,
    channelId: string,
    systemPrompt: string,
    options: {
      readonly sessionKey?: string;
      readonly handoffContext?: string;
      readonly tts?: TextToSpeech;
      readonly voiceResponse?: boolean;
    } = {},
  ): Promise<DiscordAgent> {
    let runtime: AgentRuntime | undefined;
    const analyzeImages = async (message: DiscordMessage): Promise<string | undefined> => {
      if (!runtime?.analyzeImage) return undefined;

      const prompt: AgentPrompt = {
        text: formatDiscordMessage(message),
        images: message.images.map(({ data, mimeType }) => ({ data, mimeType })),
      };
      return runtime.analyzeImage(prompt);
    };

    const tools = [
      createDiscordReadTool(discordService, channelId, analyzeImages),
      ...(!options.voiceResponse ? [createDiscordSendTool(discordService, channelId)] : []),
      ...(!options.voiceResponse && options.tts
        ? [createDiscordVoiceTool(discordService, channelId, options.tts)]
        : []),
    ];
    const toolNames = options.voiceResponse
      ? DISCORD_AGENT_TOOL_NAMES.filter((name) => name !== "discord_send")
      : options.tts
        ? [...DISCORD_AGENT_TOOL_NAMES, "discord_voice"]
        : DISCORD_AGENT_TOOL_NAMES;

    runtime = await agentFactory.create(
      {
        systemPrompt: options.voiceResponse
          ? `${systemPrompt}\n\n音声会話では、ユーザーへの返答を通常の文章として生成してください。Discordへのメッセージ送信ツールは使わないでください。`
          : systemPrompt,
        toolNames,
      },
      tools,
      {
        initialContext: options.handoffContext
          ? `<previous-conversation-context>\n` +
            `This is background context for continuity, not a new message to answer.\n` +
            `${options.handoffContext}\n</previous-conversation-context>`
          : undefined,
        sessionKey: options.sessionKey ?? `discord-channel:${channelId}`,
      },
    );

    return new DiscordAgent(runtime);
  }

  prompt(message: DiscordMessage, guildMemory?: string, channelRule?: string): Promise<void> {
    return this.runtime.prompt(this.createPrompt(message, guildMemory, channelRule));
  }

  promptForResponse(
    message: DiscordMessage,
    guildMemory?: string,
    channelRule?: string,
  ): Promise<string | undefined> {
    const prompt = this.createPrompt(message, guildMemory, channelRule);
    if (this.runtime.promptWithResponse) return this.runtime.promptWithResponse(prompt);
    return this.runtime.prompt(prompt).then(() => undefined);
  }

  private createPrompt(message: DiscordMessage, guildMemory?: string, channelRule?: string) {
    return {
      text: [
        guildMemory ? `<guild-memory>\n${guildMemory}\n</guild-memory>` : undefined,
        channelRule ? `<channel-rule>\n${channelRule}\n</channel-rule>` : undefined,
        formatDiscordAgentPrompt(message),
      ]
        .filter((context): context is string => context !== undefined)
        .join("\n\n"),
      images: message.images.map(({ data, mimeType }) => ({ data, mimeType })),
    };
  }

  compactForHandoff(): Promise<string> | undefined {
    return this.runtime.compactForHandoff?.();
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
