export type ConversationKey =
  | { readonly kind: "discord"; readonly channelId: string }
  | { readonly kind: "agent"; readonly agentId: string };

export function serializeConversationKey(key: ConversationKey): string {
  return key.kind === "discord"
    ? `discord:${encodeURIComponent(key.channelId)}`
    : `agent:${encodeURIComponent(key.agentId)}`;
}

export function createConversationSessionKey(
  key: ConversationKey,
  options: {
    readonly accessScope?: string;
    readonly useAccessScope?: boolean;
    readonly rotationDate?: string;
  } = {},
): string {
  const sessionKey =
    key.kind === "agent"
      ? `agent:${key.agentId}`
      : `discord-channel:${key.channelId}${options.useAccessScope ? `:${options.accessScope ?? "public"}` : ""}`;
  return options.rotationDate ? `${sessionKey}:rotation:${options.rotationDate}` : sessionKey;
}

export interface ChannelSessionState {
  readonly conversationKey: ConversationKey;
  readonly accessScope?: string;
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

export interface ChannelSessionStateStore {
  getOrCreate(conversationKey: ConversationKey, rotationDate: string): Promise<ChannelSessionState>;
  list(): Promise<readonly ChannelSessionState[]>;
  save(state: ChannelSessionState): Promise<void>;
}
