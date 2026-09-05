import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_SYSTEM_PROMPT_PATH = "config/SOUL.md";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadPromptFile(promptPath = DEFAULT_SYSTEM_PROMPT_PATH): Promise<string> {
  const resolvedPromptPath = resolve(promptPath);

  let content: string;
  try {
    content = await readFile(resolvedPromptPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`System prompt was not found: ${resolvedPromptPath}`, {
        cause: error,
      });
    }

    throw new Error(`Failed to read system prompt: ${resolvedPromptPath}`, {
      cause: error,
    });
  }

  const prompt = content.trim();
  if (!prompt) {
    throw new Error(`System prompt is empty: ${resolvedPromptPath}`);
  }

  return prompt;
}
