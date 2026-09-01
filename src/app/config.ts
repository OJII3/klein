import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Check, Errors } from "typebox/value";

import { KleinConfigSchema, type KleinConfig } from "./config-schema.js";

export const DEFAULT_CONFIG_PATH = "config/klein.json";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadConfig(
  configPath = process.env.KLEIN_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): Promise<KleinConfig> {
  const resolvedConfigPath = resolve(configPath);

  let content: string;
  try {
    content = await readFile(resolvedConfigPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Klein config was not found: ${resolvedConfigPath}. ` +
          `Copy config/klein.example.json to config/klein.json first.`,
      );
    }

    throw new Error(`Failed to read Klein config: ${resolvedConfigPath}`, {
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Klein config is not valid JSON: ${resolvedConfigPath}`, {
      cause: error,
    });
  }

  if (!Check(KleinConfigSchema, value)) {
    const errors = Errors(KleinConfigSchema, value)
      .slice(0, 5)
      .map((error) => `${error.instancePath || "$"}: ${error.message}`)
      .join("; ");

    throw new Error(`Klein config is invalid: ${resolvedConfigPath}. ${errors}`);
  }

  return value;
}
