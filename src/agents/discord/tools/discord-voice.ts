import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { TextToSpeech } from "@modules/tts/infrastructure/sbv2-tts";

export function createDiscordVoiceTool(
  channelApi: Pick<DiscordChannelApi, "sendAudio" | "sendTyping">,
  channelId: Parameters<DiscordChannelApi["sendMessage"]>[0],
  tts: TextToSpeech,
) {
  return defineTool({
    name: "discord_voice",
    label: "Send Discord Voice Message",
    exposure: "model-only",
    description: "Convert text to speech and send it as an audio attachment to Discord.",
    parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId, params) {
      await channelApi.sendTyping(channelId);
      const audio = await tts.synthesize(params.text);
      await channelApi.sendAudio(channelId, audio, "voice.wav");
      return {
        content: [{ type: "text", text: `Sent a voice message containing: ${params.text}` }],
        details: {},
      };
    },
  });
}
