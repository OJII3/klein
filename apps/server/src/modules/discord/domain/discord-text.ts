/** External: Discord counts all text displays in one message against a shared 4,000-character limit. */
export const DISCORD_TEXT_DISPLAY_LIMIT = 4_000;

export function normalizeEscapedNewlines(text: string): string {
  const lines = text.split("\n");
  const normalized: string[] = [];
  let fence: { readonly char: string; readonly length: number } | undefined;
  let inlineDelimiter = 0;

  for (const line of lines) {
    if (fence) {
      normalized.push(line);
      if (isClosingFence(line, fence)) fence = undefined;
      continue;
    }
    if (inlineDelimiter === 0) {
      const opening = parseOpeningFence(line);
      if (opening) {
        normalized.push(line);
        fence = opening;
        continue;
      }
    }
    const result = normalizeProseLine(line, inlineDelimiter);
    normalized.push(result.text);
    inlineDelimiter = result.inlineDelimiter;
  }

  return normalized.join("\n");
}

function normalizeProseLine(
  line: string,
  openDelimiter: number,
): { text: string; inlineDelimiter: number } {
  let text = "";
  let index = 0;
  let inlineDelimiter = openDelimiter;

  while (index < line.length) {
    if (inlineDelimiter > 0) {
      const closingIndex = findBacktickRun(line, index, inlineDelimiter);
      if (closingIndex === -1) {
        text += line.slice(index);
        break;
      }
      const end = closingIndex + inlineDelimiter;
      text += line.slice(index, end);
      index = end;
      inlineDelimiter = 0;
      continue;
    }
    if (line[index] === "`") {
      const runLength = countBackticks(line, index);
      text += line.slice(index, index + runLength);
      index += runLength;
      inlineDelimiter = runLength;
      continue;
    }
    if (line[index] === "\\" && line[index + 1] === "n") {
      text += "\n";
      index += 2;
      continue;
    }
    text += line[index];
    index += 1;
  }

  return { text, inlineDelimiter };
}

function countBackticks(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") end += 1;
  return end - start;
}

function findBacktickRun(text: string, start: number, length: number): number {
  let index = start;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const runLength = countBackticks(text, index);
    if (runLength === length) return index;
    index += runLength;
  }
  return -1;
}

function parseOpeningFence(line: string): { char: string; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  const marker = match?.[1];
  if (!marker) return undefined;
  return { char: marker[0] ?? "", length: marker.length };
}

function isClosingFence(
  line: string,
  fence: { readonly char: string; readonly length: number },
): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line);
  const marker = match?.[1];
  return marker !== undefined && marker[0] === fence.char && marker.length >= fence.length;
}

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
