export type ConversationKey = { readonly kind: "discord"; readonly channelId: string };

export function serializeConversationKey(key: ConversationKey): string {
  return `discord:${encodeURIComponent(key.channelId)}`;
}

export function isConversationKey(value: unknown): value is ConversationKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Partial<ConversationKey>;
  return key.kind === "discord" && typeof key.channelId === "string" && key.channelId.length > 0;
}

export function isSameConversationKey(a: ConversationKey, b: ConversationKey): boolean {
  return a.kind === b.kind && a.channelId === b.channelId;
}
