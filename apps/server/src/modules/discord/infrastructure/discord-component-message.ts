import { ContainerBuilder, MessageFlags, TextDisplayBuilder } from "discord.js";

export type DiscordMessageTone = "neutral" | "success" | "warning" | "danger";

const TONE_ACCENT_COLORS: Readonly<Record<DiscordMessageTone, number>> = {
  neutral: 0x747f8d,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
};

/** The longest text a single TextDisplay component accepts. */
export const DISCORD_TEXT_DISPLAY_LIMIT = 4_000;

export interface DiscordContainerMessage {
  readonly components: ContainerBuilder[];
  readonly flags: MessageFlags.IsComponentsV2;
}

/**
 * Builds a container whose body is a single text display. Without a tone the
 * container keeps the default accent color.
 */
export function createTextContainer(text: string, tone?: DiscordMessageTone): ContainerBuilder {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(text),
  );

  return tone ? container.setAccentColor(TONE_ACCENT_COLORS[tone]) : container;
}

/**
 * Builds a Components v2 message whose body is a single text display. Without
 * a tone the container keeps the default accent color.
 */
export function createTextContainerMessage(
  text: string,
  tone?: DiscordMessageTone,
): DiscordContainerMessage {
  return { components: [createTextContainer(text, tone)], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Joins lines and keeps the result within the text display limit. When a line
 * would overflow, the remaining lines are summarized by their count so the
 * reader knows the list is partial.
 */
export function truncateTextLines(
  lines: readonly string[],
  limit: number = DISCORD_TEXT_DISPLAY_LIMIT,
): string {
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
