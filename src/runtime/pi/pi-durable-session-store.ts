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

type StoredConversationState = {
  conversationKey: ChannelSessionState["conversationKey"];
  accessScope: string | null;
  sessionKey: string;
  lastActivityAt: number | null;
  lastRotationDate: string;
  hasActivitySinceRotation: boolean;
  handoffContext: string | null;
};

const ConversationStates = defineDocFamily<StoredConversationState, StoredConversationState>({
  kind: "klein.conversation-state",
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
        const state = await session.snapshot(
          ConversationStates,
          serializeConversationKey(conversationKey),
          BACKGROUND_CONTEXT,
        );
        return state
          ? fromStoredState(state)
          : {
              conversationKey,
              sessionKey: createConversationSessionKey(conversationKey),
              lastActivityAt: null,
              lastRotationDate: rotationDate,
              hasActivitySinceRotation: true,
            };
      },
      list: async () => {
        const states: ChannelSessionState[] = [];
        for (const key of await this.documentKeys(ConversationStates.definition.kind)) {
          const state = await session.snapshot(ConversationStates, key, BACKGROUND_CONTEXT);
          if (state) states.push(fromStoredState(state));
        }
        return states;
      },
      save: (state) =>
        session.commit(async (tx) => {
          const stored = toStoredState(state);
          Object.assign(
            await tx.doc(
              ConversationStates,
              serializeConversationKey(state.conversationKey),
              stored,
            ),
            stored,
          );
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

function toStoredState(state: ChannelSessionState): StoredConversationState {
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

function fromStoredState(state: Readonly<StoredConversationState>): ChannelSessionState {
  return {
    conversationKey: state.conversationKey,
    ...(state.accessScope === null ? {} : { accessScope: state.accessScope }),
    sessionKey: state.sessionKey,
    lastActivityAt: state.lastActivityAt,
    lastRotationDate: state.lastRotationDate,
    hasActivitySinceRotation: state.hasActivitySinceRotation,
    ...(state.handoffContext === null ? {} : { handoffContext: state.handoffContext }),
  };
}
