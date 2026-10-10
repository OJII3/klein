import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function createDiscordSpeakTool(speak: (text: string) => Promise<void>) {
  return defineTool({
    name: "discord_speak",
    exposure: "model-only",
    label: "Speak in voice channel",
    description: "Convert text to speech and play it in the current Discord voice channel.",
    promptSnippet: "Speak a user-visible reply in the current voice conversation.",
    promptGuidelines: [
      "Normal assistant text is not audible to the user; use discord_speak to reply.",
      "Do not call this tool when intentionally staying silent.",
    ],
    parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId, params) {
      await speak(params.text);
      return {
        content: [{ type: "text", text: `Spoke in the voice channel:\n${params.text}` }],
        details: {},
      };
    },
  });
}
