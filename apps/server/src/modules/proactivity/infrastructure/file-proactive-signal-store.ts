import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AccessScope } from "@shared/access";
import { isFileNotFound, parseJson } from "@shared/type-guards";

import type { ProactiveDeliveryMode } from "../domain/proactive-preference";
import { parseProactiveSignal, type ProactiveSignal } from "../domain/proactive-signal";
import type { ProactiveSignalStore } from "../ports/proactive-signal-store";

export class FileProactiveSignalStore implements ProactiveSignalStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async create(signal: ProactiveSignal): Promise<void> {
    await this.write(signal);
  }

  async update(signal: ProactiveSignal): Promise<void> {
    await this.write(signal);
  }

  async get(id: string): Promise<ProactiveSignal | undefined> {
    const path = this.getFilePath(id);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
    return parseProactiveSignal(parseJson(raw));
  }

  async findActiveByDedupeKey(dedupeKey: string): Promise<ProactiveSignal | undefined> {
    const signals = await this.readAll();
    return signals
      .filter((signal) => signal.dedupeKey === dedupeKey && signal.status !== "expired")
      .toSorted(compareSignals)
      .at(-1);
  }

  async listQueued(
    channelId: string,
    accessScope: AccessScope,
    mode?: ProactiveDeliveryMode,
  ): Promise<readonly ProactiveSignal[]> {
    const signals = await this.readAll();
    return signals
      .filter(
        (signal) =>
          signal.status === "queued" &&
          signal.channelId === channelId &&
          signal.accessScope === accessScope &&
          (mode === undefined || signal.delivery?.mode === mode),
      )
      .toSorted(compareSignals);
  }

  async listAllQueued(): Promise<readonly ProactiveSignal[]> {
    const signals = await this.readAll();
    return signals.filter((signal) => signal.status === "queued").toSorted(compareSignals);
  }

  async countSurfacedSince(
    channelId: string,
    accessScope: AccessScope,
    since: string,
  ): Promise<number> {
    const sinceTime = Date.parse(since);
    if (!Number.isFinite(sinceTime)) throw new TypeError("集計の開始日時が不正です。");
    const signals = await this.readAll();
    return signals.filter(
      (signal) =>
        signal.channelId === channelId &&
        signal.accessScope === accessScope &&
        signal.delivery?.surfacedAt !== undefined &&
        Date.parse(signal.delivery.surfacedAt) >= sinceTime,
    ).length;
  }

  private async readAll(): Promise<ProactiveSignal[]> {
    const paths = await this.getFiles();
    return Promise.all(
      paths.map(async (path) => parseProactiveSignal(parseJson(await readFile(path, "utf8")))),
    );
  }

  private async getFiles(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => resolve(this.directory, entry.name));
  }

  private async write(signal: ProactiveSignal): Promise<void> {
    const path = this.getFilePath(signal.id);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(signal, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private getFilePath(id: string): string {
    return resolve(this.directory, `${encodeURIComponent(id)}.json`);
  }
}

function compareSignals(left: ProactiveSignal, right: ProactiveSignal): number {
  return left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id);
}
