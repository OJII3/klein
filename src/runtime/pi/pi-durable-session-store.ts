import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type Cursor,
  type Session,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  ChannelSessionState,
  ChannelSessionStateStore,
} from "../../app/channel-session-state-store";

const SessionConversations = defineDocFamily<{ conversationIds: ConversationId[] }, null>({
  kind: "klein.session-conversations",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ conversationIds: [] }),
});

type StoredChannelState = {
  channelId: string;
  accessScope: string | null;
  sessionKey: string;
  lastActivityAt: number | null;
  lastRotationDate: string;
  hasActivitySinceRotation: boolean;
  handoffContext: string | null;
};

const DiscordChannelStates = defineDocFamily<StoredChannelState, StoredChannelState>({
  kind: "klein.discord-channel-state",
  version: 1,
  scope: "session",
  family: true,
  initial: (state) => state,
});

const LegacyJsonMigration = defineDoc<{
  indexCompleted: boolean;
  discordChannelsCompleted: boolean;
}>({
  kind: "klein.legacy-session-json-migration",
  version: 1,
  scope: "session",
  initial: () => ({ indexCompleted: false, discordChannelsCompleted: false }),
});

export class PiDurableSessionStore {
  readonly channelStates: ChannelSessionStateStore;

  constructor(
    private readonly session: Session,
    private readonly storage: Storage,
  ) {
    this.channelStates = {
      getOrCreate: async (channelId, rotationDate) => {
        const state = await session.snapshot(DiscordChannelStates, channelId, BACKGROUND_CONTEXT);
        return state
          ? fromStoredState(state)
          : {
              channelId,
              sessionKey: `discord-channel:${channelId}`,
              lastActivityAt: null,
              lastRotationDate: rotationDate,
              hasActivitySinceRotation: true,
            };
      },
      list: async () => {
        const states: ChannelSessionState[] = [];
        for (const key of await this.documentKeys(DiscordChannelStates.definition.kind)) {
          const state = await session.snapshot(DiscordChannelStates, key, BACKGROUND_CONTEXT);
          if (state) states.push(fromStoredState(state));
        }
        return states;
      },
      save: (state) =>
        session.commit(async (tx) => {
          const stored = toStoredState(state);
          Object.assign(await tx.doc(DiscordChannelStates, state.channelId, stored), stored);
        }, BACKGROUND_CONTEXT),
    };
  }

  async getConversationIds(sessionKey: string): Promise<readonly ConversationId[]> {
    const document = await this.session.snapshot(
      SessionConversations,
      sessionKey,
      BACKGROUND_CONTEXT,
    );
    return document ? [...document.conversationIds] : [];
  }

  async loadSessionIndex(): Promise<Record<string, ConversationId[]>> {
    const entries = await Promise.all(
      (await this.documentKeys(SessionConversations.definition.kind)).map(async (key) => [
        key,
        [...(await this.getConversationIds(key))],
      ]),
    );
    return Object.fromEntries(entries);
  }

  async registerConversation(tx: Tx, sessionKey: string, id: ConversationId): Promise<void> {
    const document = await tx.doc(SessionConversations, sessionKey, null);
    if (!document.conversationIds.includes(id)) document.conversationIds.push(id);
  }

  async migrateLegacyJson(options: {
    sessionIndexPath: string;
    channelStateDirectory?: string;
  }): Promise<void> {
    const completed = await this.session.snapshot(LegacyJsonMigration, BACKGROUND_CONTEXT);
    const importIndex = !completed?.indexCompleted;
    const importDiscordChannels =
      options.channelStateDirectory !== undefined && !completed?.discordChannelsCompleted;
    if (!importIndex && !importDiscordChannels) return;

    const indexContent = importIndex ? await readOptionalFile(options.sessionIndexPath) : undefined;
    const index = indexContent === undefined ? {} : parseSessionIndex(JSON.parse(indexContent));
    const states: ChannelSessionState[] = [];
    if (importDiscordChannels && options.channelStateDirectory !== undefined) {
      let files: Dirent[];
      try {
        files = await readdir(options.channelStateDirectory, { withFileTypes: true });
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
        files = [];
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        const state = parseChannelState(
          JSON.parse(await readFile(resolve(options.channelStateDirectory, file.name), "utf8")),
        );
        if (file.name !== `${encodeURIComponent(state.channelId)}.json`) {
          throw new Error(`Channel session state filename does not match channel: ${file.name}`);
        }
        states.push(state);
      }
    }

    await this.session.commit(async (tx) => {
      const migration = await tx.doc(LegacyJsonMigration);
      if (importIndex && !migration.indexCompleted) {
        for (const [key, ids] of Object.entries(index)) {
          await tx.doc(SessionConversations, key, null);
          for (const id of ids) await this.registerConversation(tx, key, id);
        }
        migration.indexCompleted = true;
      }
      if (importDiscordChannels && !migration.discordChannelsCompleted) {
        for (const state of states) {
          const stored = toStoredState(state);
          Object.assign(await tx.doc(DiscordChannelStates, state.channelId, stored), stored);
        }
        migration.discordChannelsCompleted = true;
      }
    }, BACKGROUND_CONTEXT);
  }

  private async documentKeys(kind: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanDocuments(
        { scope: { kind: "session" }, kind, at: "current" },
        100,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const record of page.items) {
        if (record.key !== undefined) keys.push(record.key);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return keys;
  }
}

function toStoredState(state: ChannelSessionState): StoredChannelState {
  return {
    channelId: state.channelId,
    accessScope: state.accessScope ?? null,
    sessionKey: state.sessionKey,
    lastActivityAt: state.lastActivityAt,
    lastRotationDate: state.lastRotationDate,
    hasActivitySinceRotation: state.hasActivitySinceRotation,
    handoffContext: state.handoffContext ?? null,
  };
}

function fromStoredState(state: Readonly<StoredChannelState>): ChannelSessionState {
  return {
    channelId: state.channelId,
    ...(state.accessScope === null ? {} : { accessScope: state.accessScope }),
    sessionKey: state.sessionKey,
    lastActivityAt: state.lastActivityAt,
    lastRotationDate: state.lastRotationDate,
    hasActivitySinceRotation: state.hasActivitySinceRotation,
    ...(state.handoffContext === null ? {} : { handoffContext: state.handoffContext }),
  };
}

function parseSessionIndex(value: unknown): Record<string, ConversationId[]> {
  if (!isObject(value)) throw new Error("Invalid legacy session index");
  for (const ids of Object.values(value)) {
    if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
      throw new Error("Invalid legacy session conversation IDs");
    }
  }
  return value as Record<string, ConversationId[]>;
}

function parseChannelState(value: unknown): ChannelSessionState {
  if (
    !isObject(value) ||
    typeof value.channelId !== "string" ||
    !value.channelId ||
    typeof value.sessionKey !== "string" ||
    !value.sessionKey ||
    (value.lastActivityAt !== null &&
      (typeof value.lastActivityAt !== "number" || !Number.isFinite(value.lastActivityAt))) ||
    typeof value.lastRotationDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.lastRotationDate) ||
    typeof value.hasActivitySinceRotation !== "boolean" ||
    (value.accessScope !== undefined && typeof value.accessScope !== "string") ||
    (value.handoffContext !== undefined && typeof value.handoffContext !== "string")
  ) {
    throw new Error("Invalid legacy channel session state");
  }
  return value as unknown as ChannelSessionState;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
    return undefined;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
