import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { isFileNotFound, parseJson } from "./type-guards";

export interface ReadJsonRecordOptions {
  /** Called with the record path and the failure before the file moves to `corrupt/`. */
  readonly onCorrupt?: (path: string, error: unknown) => void;
}

/**
 * Reads one JSON record and validates it with `parse`. A missing file yields `undefined`. A parse
 * or validation failure moves the file into a sibling `corrupt/` directory and yields `undefined`.
 * Other read errors, such as a permission failure, still throw.
 */
export async function readJsonRecord<T>(
  path: string,
  parse: (value: unknown) => T,
  options: ReadJsonRecordOptions = {},
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }

  try {
    return parse(parseJson(raw));
  } catch (error) {
    options.onCorrupt?.(path, error);
    await quarantineFile(path);
    return undefined;
  }
}

/**
 * Moves an unreadable record into `<dirname(path)>/corrupt/`. A missing source or a failed move is
 * ignored so that skipping a read never throws. A failed move leaves the original file in place.
 */
export async function quarantineFile(path: string): Promise<void> {
  const directory = resolve(dirname(path), "corrupt");
  const target = resolve(directory, `${basename(path)}.${Date.now()}.${randomUUID()}.corrupt`);
  try {
    await mkdir(directory, { recursive: true });
    await rename(path, target);
  } catch {
    // Keep the original file so the next read retries the quarantine.
  }
}
