import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ChannelSessionState {
  readonly channelId: string;
  readonly sessionKey: string;
  readonly lastActivityAt: number | null;
  readonly lastRotationDate: string;
  readonly hasActivitySinceRotation: boolean;
  readonly handoffContext?: string;
}

export const CHANNEL_ROTATION_IDLE_MS = 60 * 60 * 1_000;

const ROTATION_TIME_ZONE = "Asia/Tokyo";
const ROTATION_HOUR = 5;
const rotationDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  month: "2-digit",
  timeZone: ROTATION_TIME_ZONE,
  year: "numeric",
});

export function getChannelRotationDate(timestamp: number): string {
  const parts = Object.fromEntries(
    rotationDateFormatter
      .formatToParts(new Date(timestamp))
      .map(({ type, value }) => [type, value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const date = new Date(Date.UTC(year, month - 1, day - (hour < ROTATION_HOUR ? 1 : 0)));
  return date.toISOString().slice(0, 10);
}

export function isChannelRotationDue(state: ChannelSessionState, timestamp: number): boolean {
  return (
    state.hasActivitySinceRotation &&
    state.lastActivityAt !== null &&
    timestamp - state.lastActivityAt >= CHANNEL_ROTATION_IDLE_MS &&
    getChannelRotationDate(timestamp) > state.lastRotationDate
  );
}

export class ChannelSessionStateStore {
  constructor(private readonly directory: string) {}

  async getOrCreate(channelId: string, rotationDate: string): Promise<ChannelSessionState> {
    try {
      const content = await readFile(this.getFilePath(channelId), "utf8");
      const state = JSON.parse(content) as ChannelSessionState;
      if (state.channelId !== channelId || !state.sessionKey) {
        throw new Error(`Invalid channel session state: ${channelId}`);
      }
      return state;
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }

    return {
      channelId,
      sessionKey: `discord-channel:${channelId}`,
      lastActivityAt: null,
      lastRotationDate: rotationDate,
      hasActivitySinceRotation: true,
    };
  }

  async list(): Promise<readonly ChannelSessionState[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }

    const paths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => resolve(this.directory, entry.name));

    return Promise.all(
      paths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as ChannelSessionState),
    );
  }

  async save(state: ChannelSessionState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const filePath = this.getFilePath(state.channelId);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  }

  private getFilePath(channelId: string): string {
    return resolve(this.directory, `${encodeURIComponent(channelId)}.json`);
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
