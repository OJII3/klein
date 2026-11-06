import { createHash } from "node:crypto";

export function normalizeWatchOutput(output: string): string {
  return output.replaceAll(/\r\n?/gu, "\n").trimEnd();
}

export function hashWatchOutput(output: string): string {
  return createHash("sha256").update(normalizeWatchOutput(output)).digest("hex");
}

export function truncateWatchOutput(output: string, maxCharacters = 64 * 1_024): string {
  if (output.length <= maxCharacters) return output;
  return `${output.slice(0, maxCharacters)}\n…（${output.length - maxCharacters}文字省略）`;
}
