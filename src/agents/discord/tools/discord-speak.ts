import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export function createDiscordSpeakTool(
  speak: (text: string, toolCallId?: string) => Promise<void>,
) {
  return defineTool({
    name: "discord_speak",
    callers: ["model"],
    description: "Convert text to speech and play it in the current Discord voice channel.",
    parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
    async execute(params, api) {
      await speak(params.text, api.callId);
      return {
        output: [{ type: "text", text: `Started preparing a voice reply:\n${params.text}` }],
        details: {},
      };
    },
  });
}
