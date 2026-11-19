import { isWithinQuietHours, japanDateKey } from "./japan-time";
import type {
  ProactiveDeliveryMode,
  ProactivePreferences,
  ProactiveTopicPreference,
} from "./proactive-preference";
import type { ProactiveSignal, ProactiveUrgency } from "./proactive-signal";

export interface ProactivePolicyDefaults {
  readonly defaultMode: ProactiveDeliveryMode;
  readonly quietHours?: { readonly start: string; readonly end: string };
  readonly digestAt?: string;
  readonly maxPerDay: number;
  readonly publicChannels: boolean;
}

export interface DeliveryDecision {
  readonly mode: ProactiveDeliveryMode;
  readonly reason: string;
}

const MODE_BY_URGENCY: Readonly<Record<ProactiveUrgency, ProactiveDeliveryMode>> = {
  now: "interrupt",
  today: "attach",
  digest: "digest",
  silent: "silent",
};

export function decideDelivery(input: {
  signal: ProactiveSignal;
  preferences: ProactivePreferences;
  defaults: ProactivePolicyDefaults;
  now: number;
  publicChannel: boolean;
  deliveredToday: number;
}): DeliveryDecision {
  const { signal, preferences, defaults, now, publicChannel, deliveredToday } = input;

  if (publicChannel && !defaults.publicChannels) {
    return { mode: "silent", reason: "public-channel-disabled" };
  }

  const topicPreference = findTopicPreference(preferences.topics, signal.topic, now);
  if (topicPreference?.mode === "mute") {
    return { mode: "silent", reason: "topic-muted" };
  }
  if (topicPreference?.mode === "urgent-only" && signal.urgency !== "now") {
    return { mode: "silent", reason: "urgent-only" };
  }

  const quietHours = preferences.delivery.quietHours ?? defaults.quietHours;
  if (quietHours && isWithinQuietHours(quietHours, now)) {
    return { mode: "attach", reason: "quiet-hours" };
  }

  const maxPerDay = preferences.delivery.maxPerDay ?? defaults.maxPerDay;
  if (signal.urgency !== "now" && deliveredToday >= maxPerDay) {
    return { mode: "attach", reason: "daily-limit" };
  }

  return { mode: MODE_BY_URGENCY[signal.urgency], reason: `urgency-${signal.urgency}` };
}

function findTopicPreference(
  topics: readonly ProactiveTopicPreference[],
  topic: string,
  now: number,
): ProactiveTopicPreference | undefined {
  const key = normalizeTopic(topic);
  return topics.find(
    (preference) => normalizeTopic(preference.topic) === key && isPreferenceActive(preference, now),
  );
}

function isPreferenceActive(preference: ProactiveTopicPreference, now: number): boolean {
  if (preference.until === undefined) return true;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(preference.until)) {
    return japanDateKey(now) <= preference.until;
  }
  return now < Date.parse(preference.until);
}

function normalizeTopic(value: string): string {
  return value.trim().toLowerCase();
}
