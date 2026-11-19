import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isFileNotFound } from "@shared/type-guards";

import {
  DEFAULT_PROACTIVE_PREFERENCES,
  parseProactivePreferences,
  renderProactivePreferences,
  updateProactivePreferences,
  type ProactivePreferenceChange,
  type ProactivePreferences,
} from "../domain/proactive-preference";
import type { ProactivePreferenceStore } from "../ports/proactive-preference-store";

export class FileProactivePreferenceStore implements ProactivePreferenceStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async read(): Promise<ProactivePreferences> {
    const markdown = await this.readMarkdown();
    return markdown === undefined
      ? DEFAULT_PROACTIVE_PREFERENCES
      : parseProactivePreferences(markdown);
  }

  async update(change: ProactivePreferenceChange): Promise<ProactivePreferences> {
    return this.runWrite(async () => {
      const markdown =
        (await this.readMarkdown()) ?? renderProactivePreferences(DEFAULT_PROACTIVE_PREFERENCES);
      const updated = updateProactivePreferences(markdown, change);
      await this.write(updated);
      return parseProactivePreferences(updated);
    });
  }

  private async readMarkdown(): Promise<string | undefined> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
  }

  private async write(markdown: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, markdown, "utf8");
    await rename(temporaryPath, this.filePath);
  }

  private runWrite<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.writeQueue.catch(() => undefined).then(operation);
    this.writeQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}
