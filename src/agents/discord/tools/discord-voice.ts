import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { TextToSpeech } from "@modules/tts/infrastructure/sbv2-tts";

export function createDiscordVoiceTool(
  discordService: Pick<DiscordService, "sendAudio" | "sendTyping">,
  channelId: Parameters<DiscordService["sendMessage"]>[0],
  tts: TextToSpeech,
) {
  return defineTool({
    name: "discord_voice",
    exposure: "model-only",
    label: "Send voice message",
    description: "Convert text to speech and send it as an audio attachment to Discord.",
    promptSnippet: "Send a spoken message to Discord.",
    promptGuidelines: [
      "Use discord_voice when the user asks for a spoken or voice message.",
      "The generated audio is attached to the current Discord conversation.",
    ],
    parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId, params) {
      await discordService.sendTyping(channelId);
      const audio = await tts.synthesize(params.text);
      await discordService.sendAudio(channelId, audio, "voice.wav");
      return {
        content: [{ type: "text", text: `Sent a voice message containing: ${params.text}` }],
        details: {},
      };
    },
  });
}
