/** The longest text a single TextDisplay component accepts. */
export const DISCORD_TEXT_DISPLAY_LIMIT = 4_000;

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
