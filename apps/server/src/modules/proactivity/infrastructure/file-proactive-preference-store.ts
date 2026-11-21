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
import {
  proactivePreferenceKey,
  type ProactivePreferenceTarget,
} from "../domain/proactive-preference-scope";
import type { ProactivePreferenceStore } from "../ports/proactive-preference-store";

export class FileProactivePreferenceStore implements ProactivePreferenceStore {
  private readonly directory: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async read(target: ProactivePreferenceTarget): Promise<ProactivePreferences> {
    const markdown = await this.readMarkdown(this.getFilePath(target));
    return markdown === undefined
      ? DEFAULT_PROACTIVE_PREFERENCES
      : parseProactivePreferences(markdown);
  }

  async update(
    target: ProactivePreferenceTarget,
    change: ProactivePreferenceChange,
  ): Promise<ProactivePreferences> {
    return this.runWrite(async () => {
      const filePath = this.getFilePath(target);
      const markdown =
        (await this.readMarkdown(filePath)) ??
        renderProactivePreferences(DEFAULT_PROACTIVE_PREFERENCES);
      const updated = updateProactivePreferences(markdown, change);
      await this.write(filePath, updated);
      return parseProactivePreferences(updated);
    });
  }

  private async readMarkdown(filePath: string): Promise<string | undefined> {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
  }

  private async write(filePath: string, markdown: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, markdown, "utf8");
    await rename(temporaryPath, filePath);
  }

  private getFilePath(target: ProactivePreferenceTarget): string {
    return resolve(this.directory, `${proactivePreferenceKey(target)}.md`);
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
