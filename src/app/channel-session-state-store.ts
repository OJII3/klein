export type ConversationKey = { readonly kind: "discord"; readonly channelId: string };

export function serializeConversationKey(key: ConversationKey): string {
  return `discord:${encodeURIComponent(key.channelId)}`;
}

export function createConversationSessionKey(
  key: ConversationKey,
  options: {
    readonly accessScope?: string;
    readonly useAccessScope?: boolean;
    readonly rotationBucket?: string;
  } = {},
): string {
  const sessionKey = `discord-channel:${key.channelId}${options.useAccessScope ? `:${options.accessScope ?? "public"}` : ""}`;
  return options.rotationBucket ? `${sessionKey}:rotation:${options.rotationBucket}` : sessionKey;
}

export interface ChannelSessionState {
  readonly conversationKey: ConversationKey;
  readonly accessScope?: string;
  readonly sessionKey: string;
  readonly lastActivityAt: number | null;
  /** Last rotation bucket the session was rotated into. Persisted under the legacy `lastRotationDate` key. */
  readonly lastRotationDate: string;
  readonly hasActivitySinceRotation: boolean;
  readonly handoffContext?: string;
}

export const CHANNEL_ROTATION_IDLE_MS = 60 * 60 * 1_000;

const ROTATION_TIME_ZONE = "Asia/Tokyo";
const CHANNEL_ROTATION_INTERVAL_HOURS = 4;
const rotationDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  month: "2-digit",
  timeZone: ROTATION_TIME_ZONE,
  year: "numeric",
});

/** Identifies the rotation window (a 4-hour block in JST) that contains `timestamp`. */
export function getChannelRotationBucket(timestamp: number): string {
  const parts = Object.fromEntries(
    rotationDateFormatter
      .formatToParts(new Date(timestamp))
      .map(({ type, value }) => [type, value]),
  );
  const hour = Number(parts.hour);
  const bucketHour = hour - (hour % CHANNEL_ROTATION_INTERVAL_HOURS);
  return `${parts.year}-${parts.month}-${parts.day}T${String(bucketHour).padStart(2, "0")}`;
}

export function isChannelRotationDue(state: ChannelSessionState, timestamp: number): boolean {
  return (
    state.hasActivitySinceRotation &&
    state.lastActivityAt !== null &&
    timestamp - state.lastActivityAt >= CHANNEL_ROTATION_IDLE_MS &&
    getChannelRotationBucket(timestamp) > state.lastRotationDate
  );
}

export interface ChannelSessionStateStore {
  getOrCreate(
    conversationKey: ConversationKey,
    rotationBucket: string,
  ): Promise<ChannelSessionState>;
  list(): Promise<readonly ChannelSessionState[]>;
  save(state: ChannelSessionState): Promise<void>;
}
