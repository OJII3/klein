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
