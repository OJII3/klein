import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
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
  ConversationKey,
} from "../../app/channel-session-state-store";
import {
  createConversationSessionKey,
  serializeConversationKey,
} from "../../app/channel-session-state-store";

const SessionConversations = defineDocFamily<{ conversationIds: ConversationId[] }, null>({
  kind: "klein.session-conversations",
  version: 1,
  scope: "session",
  family: true,
  checkpointWhen: () => false,
  initial: () => ({ conversationIds: [] }),
});

type StoredChannelState = {
  conversationKey?: ConversationKey;
  channelId?: string;
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
  checkpointWhen: () => false,
  initial: (state) => state,
});

export class PiDurableSessionStore {
  readonly channelStates: ChannelSessionStateStore;

  constructor(
    private readonly session: Session,
    private readonly storage: Storage,
  ) {
    this.channelStates = {
      getOrCreate: async (conversationKey, rotationDate) => {
        const key = serializeConversationKey(conversationKey);
        const state = await session.snapshot(DiscordChannelStates, key, BACKGROUND_CONTEXT);
        if (state) return fromStoredState(state, conversationKey);

        const legacyKey = getLegacyStorageKey(conversationKey);
        const legacyState =
          legacyKey === key
            ? undefined
            : await session.snapshot(DiscordChannelStates, legacyKey, BACKGROUND_CONTEXT);
        if (legacyState) {
          const restored = migrateLegacyState(legacyState, conversationKey);
          await this.migrateState(legacyKey, key, legacyState, restored);
          return restored;
        }

        return {
          conversationKey,
          sessionKey: createConversationSessionKey(conversationKey),
          lastActivityAt: null,
          lastRotationDate: rotationDate,
          hasActivitySinceRotation: true,
        };
      },
      list: async () => {
        const entries: Array<{
          readonly storageKey: string;
          readonly stored: Readonly<StoredChannelState>;
          readonly state: ChannelSessionState;
        }> = [];
        for (const storageKey of await this.documentKeys(DiscordChannelStates.definition.kind)) {
          const stored = await session.snapshot(
            DiscordChannelStates,
            storageKey,
            BACKGROUND_CONTEXT,
          );
          if (stored) entries.push({ storageKey, stored, state: fromStoredState(stored) });
        }

        const canonicalKeys = new Set(
          entries
            .filter(({ stored }) => stored.conversationKey)
            .map(({ state }) => serializeConversationKey(state.conversationKey)),
        );
        const states = new Map<string, ChannelSessionState>();
        for (const { storageKey, stored, state } of entries) {
          const key = serializeConversationKey(state.conversationKey);
          if (storageKey !== key) {
            if (!canonicalKeys.has(key)) {
              const migrated = migrateLegacyState(stored, state.conversationKey);
              await this.migrateState(storageKey, key, stored, migrated);
              states.set(key, migrated);
              canonicalKeys.add(key);
            } else {
              await session.commit(
                (tx) => tx.retireDoc(DiscordChannelStates, storageKey),
                BACKGROUND_CONTEXT,
              );
            }
            continue;
          }
          states.set(key, state);
        }
        return [...states.values()];
      },
      save: (state) =>
        session.commit(async (tx) => {
          const key = serializeConversationKey(state.conversationKey);
          const stored = toStoredState(state);
          Object.assign(await tx.doc(DiscordChannelStates, key, stored), stored);
        }, BACKGROUND_CONTEXT),
      migrate: (previous, next) => this.migrateConversation(previous, next),
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

  private async migrateState(
    legacyStorageKey: string,
    storageKey: string,
    legacyState: Readonly<StoredChannelState>,
    state: ChannelSessionState,
  ): Promise<void> {
    const legacyConversationIds =
      legacyState.sessionKey === state.sessionKey
        ? []
        : await this.getConversationIds(legacyState.sessionKey);
    await this.session.commit(async (tx) => {
      const stored = toStoredState(state);
      Object.assign(await tx.doc(DiscordChannelStates, storageKey, stored), stored);
      await tx.retireDoc(DiscordChannelStates, legacyStorageKey);

      if (legacyConversationIds.length > 0) {
        await this.registerConversationIndex(tx, state.sessionKey, legacyConversationIds);
        await tx.retireDoc(SessionConversations, legacyState.sessionKey);
      }
    }, BACKGROUND_CONTEXT);
  }

  private async migrateConversation(
    previous: ChannelSessionState,
    next: ChannelSessionState,
  ): Promise<void> {
    const canonicalSourceKey = serializeConversationKey(previous.conversationKey);
    let sourceStorageKey = canonicalSourceKey;
    let sourceState = await this.session.snapshot(
      DiscordChannelStates,
      sourceStorageKey,
      BACKGROUND_CONTEXT,
    );
    if (!sourceState) {
      sourceStorageKey = getLegacyStorageKey(previous.conversationKey);
      if (sourceStorageKey !== canonicalSourceKey) {
        sourceState = await this.session.snapshot(
          DiscordChannelStates,
          sourceStorageKey,
          BACKGROUND_CONTEXT,
        );
      }
    }
    if (sourceState) {
      await this.migrateState(
        sourceStorageKey,
        serializeConversationKey(next.conversationKey),
        sourceState,
        next,
      );
    } else {
      await this.channelStates.save(next);
    }
  }

  private async registerConversationIndex(
    tx: Tx,
    sessionKey: string,
    conversationIds: readonly ConversationId[],
  ): Promise<void> {
    const document = await tx.doc(SessionConversations, sessionKey, null);
    for (const conversationId of conversationIds) {
      if (!document.conversationIds.includes(conversationId)) {
        document.conversationIds.push(conversationId);
      }
    }
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

function getLegacyStorageKey(key: ConversationKey): string {
  return key.kind === "discord" ? key.channelId : `domain-agent:${key.agentId}`;
}

function migrateLegacyState(
  state: Readonly<StoredChannelState>,
  conversationKey: ConversationKey,
): ChannelSessionState {
  const sessionKey =
    conversationKey.kind === "agent"
      ? createConversationSessionKey(conversationKey, {
          rotationDate: /:rotation:(\d{4}-\d{2}-\d{2})$/.exec(state.sessionKey)?.[1],
        })
      : state.sessionKey;
  return {
    conversationKey,
    ...(state.accessScope === null ? {} : { accessScope: state.accessScope }),
    sessionKey,
    lastActivityAt: state.lastActivityAt,
    lastRotationDate: state.lastRotationDate,
    hasActivitySinceRotation: state.hasActivitySinceRotation,
    ...(state.handoffContext === null ? {} : { handoffContext: state.handoffContext }),
  };
}

function toStoredState(state: ChannelSessionState): StoredChannelState {
  return {
    conversationKey: state.conversationKey,
    accessScope: state.accessScope ?? null,
    sessionKey: state.sessionKey,
    lastActivityAt: state.lastActivityAt,
    lastRotationDate: state.lastRotationDate,
    hasActivitySinceRotation: state.hasActivitySinceRotation,
    handoffContext: state.handoffContext ?? null,
  };
}

function fromStoredState(
  state: Readonly<StoredChannelState>,
  knownKey?: ConversationKey,
): ChannelSessionState {
  const conversationKey =
    state.conversationKey ?? knownKey ?? legacyConversationKey(state.channelId);
  return {
    conversationKey,
    ...(state.accessScope === null ? {} : { accessScope: state.accessScope }),
    sessionKey: state.sessionKey,
    lastActivityAt: state.lastActivityAt,
    lastRotationDate: state.lastRotationDate,
    hasActivitySinceRotation: state.hasActivitySinceRotation,
    ...(state.handoffContext === null ? {} : { handoffContext: state.handoffContext }),
  };
}

function legacyConversationKey(channelId: string | undefined): ConversationKey {
  const legacyAgentId = /^domain-agent:([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(channelId ?? "")?.[1];
  return legacyAgentId
    ? { kind: "agent", agentId: legacyAgentId }
    : { kind: "discord", channelId: channelId ?? "" };
}
