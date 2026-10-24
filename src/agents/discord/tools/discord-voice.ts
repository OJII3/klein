import { defineTool } from "@earendil-works/pi-durable";
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
    callers: ["model"],
    description: "Convert text to speech and send it as an audio attachment to Discord.",
    parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
    async execute(params) {
      await discordService.sendTyping(channelId);
      const audio = await tts.synthesize(params.text);
      await discordService.sendAudio(channelId, audio, "voice.wav");
      return {
        output: [{ type: "text", text: `Sent a voice message containing: ${params.text}` }],
        details: {},
      };
    },
  });
}
