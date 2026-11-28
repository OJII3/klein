/** External: Discord counts all text displays in one message against a shared 4,000-character limit. */
export const DISCORD_TEXT_DISPLAY_LIMIT = 4_000;

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
