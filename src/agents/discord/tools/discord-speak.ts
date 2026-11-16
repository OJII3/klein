import { Type } from "typebox";

import { defineSurfaceTool } from "./surface-tool";

export function createDiscordSpeakTool(
  speak: (text: string, toolCallId?: string) => Promise<void>,
) {
  return defineSurfaceTool({
    name: "discord_speak",
    label: "Speak in Discord Voice Channel",
    exposure: "model-only",
    description: "Convert text to speech and play it in the current Discord voice channel.",
    parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
    async execute(toolCallId, params) {
      await speak(params.text, toolCallId);
      return {
        content: [{ type: "text", text: `Started preparing a voice reply:\n${params.text}` }],
        details: {},
      };
    },
  });
}
