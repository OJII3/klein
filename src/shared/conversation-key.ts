export type ConversationKey = { readonly kind: "discord"; readonly channelId: string };

export function serializeConversationKey(key: ConversationKey): string {
  return `discord:${encodeURIComponent(key.channelId)}`;
}

export function isSameConversationKey(a: ConversationKey, b: ConversationKey): boolean {
  return a.kind === b.kind && a.channelId === b.channelId;
}
