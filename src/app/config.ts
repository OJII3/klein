import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Check, Errors } from "typebox/value";
import { parse, type ParseError } from "jsonc-parser";

import { ConfigSchema, type AppConfig } from "./config-schema";

export const DEFAULT_CONFIG_PATH = "config/config.jsonc";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadConfig(
  configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): Promise<AppConfig> {
  const resolvedConfigPath = resolve(configPath);

  let content: string;
  try {
    content = await readFile(resolvedConfigPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Configuration was not found: ${resolvedConfigPath}. ` +
          `Copy config/config.example.json to config/config.jsonc first.`,
      );
    }

    throw new Error(`Failed to read configuration: ${resolvedConfigPath}`, {
      cause: error,
    });
  }

  let value: unknown;
  try {
    const parseErrors: ParseError[] = [];
    value = parse(content, parseErrors);
    if (parseErrors.length > 0) throw new SyntaxError("Invalid JSONC syntax");
  } catch (error) {
    throw new Error(`Configuration is not valid JSONC: ${resolvedConfigPath}`, {
      cause: error,
    });
  }

  if (!Check(ConfigSchema, value)) {
    const errors = Errors(ConfigSchema, value)
      .slice(0, 5)
      .map((error) => `${error.instancePath || "$"}: ${error.message}`)
      .join("; ");

    throw new Error(`Configuration is invalid: ${resolvedConfigPath}. ${errors}`);
  }

  return value;
}
