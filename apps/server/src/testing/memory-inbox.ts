import {
  isSameConversationKey,
  serializeConversationKey,
  type ConversationKey,
} from "@shared/conversation-key";
import type {
  ConversationInboxStore,
  InboxItem,
  InboxItemOutcome,
  NewInboxItem,
} from "../app/conversation-inbox";

export class MemoryInbox implements ConversationInboxStore {
  private readonly items = new Map<string, InboxItem>();

  async enqueue(item: NewInboxItem): Promise<boolean> {
    const key = itemKey(item.conversationKey, item.id);
    if (this.items.has(key)) return false;
    this.items.set(key, { ...item, status: "pending", attempts: 0 });
    return true;
  }

  async claimNext(conversationKey: ConversationKey): Promise<InboxItem | undefined> {
    const next = [...this.items.values()]
      .filter(
        (item) =>
          item.status === "pending" && isSameConversationKey(item.conversationKey, conversationKey),
      )
      .toSorted(compareItems)[0];
    if (next === undefined) return undefined;

    const claimed: InboxItem = {
      ...next,
      status: "claimed",
      attempts: next.attempts + 1,
      claimedAt: new Date().toISOString(),
    };
    this.items.set(itemKey(claimed.conversationKey, claimed.id), claimed);
    return claimed;
  }

  async finish(item: InboxItem, outcome: InboxItemOutcome, error?: string): Promise<void> {
    this.items.set(itemKey(item.conversationKey, item.id), {
      ...item,
      status: outcome,
      finishedAt: new Date().toISOString(),
      ...(error === undefined ? {} : { error }),
    });
  }

  async recoverClaims(): Promise<number> {
    const claimed = [...this.items.values()].filter((item) => item.status === "claimed");
    for (const item of claimed) {
      this.items.set(itemKey(item.conversationKey, item.id), {
        ...item,
        status: "pending",
        claimedAt: undefined,
      });
    }
    return claimed.length;
  }

  async listPendingConversations(): Promise<readonly ConversationKey[]> {
    const conversations = new Map<string, ConversationKey>();
    for (const item of this.items.values()) {
      if (item.status !== "pending") continue;
      conversations.set(serializeConversationKey(item.conversationKey), item.conversationKey);
    }
    return [...conversations]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, conversationKey]) => conversationKey);
  }

  get(conversationKey: ConversationKey, id: string): InboxItem | undefined {
    return this.items.get(itemKey(conversationKey, id));
  }

  list(): readonly InboxItem[] {
    return [...this.items.values()];
  }
}

function itemKey(conversationKey: ConversationKey, id: string): string {
  return `${serializeConversationKey(conversationKey)}\u0000${id}`;
}

function compareItems(left: InboxItem, right: InboxItem): number {
  return left.enqueuedAt.localeCompare(right.enqueuedAt) || left.id.localeCompare(right.id);
}
