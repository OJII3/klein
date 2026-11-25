import assert from "node:assert/strict";

import { test } from "bun:test";

import { decideDelivery, type ProactivePolicyDefaults } from "./proactive-delivery-policy";
import { DEFAULT_PROACTIVE_PREFERENCES, type ProactivePreferences } from "./proactive-preference";
import type { ProactiveSignal, ProactiveUrgency } from "./proactive-signal";

const MINUTE = 60_000;
const JST_OFFSET = 9 * 60 * MINUTE;

function japanTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET;
}

const defaults: ProactivePolicyDefaults = {
  defaultMode: "attach",
  quietHours: { start: "23:00", end: "08:00" },
  digestAt: "09:00",
  maxPerDay: 3,
  publicChannels: false,
};

const signal: ProactiveSignal = {
  version: 1,
  id: "signal-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  audience: "owner",
  source: { kind: "watch", ref: "watch-1" },
  topic: "weather",
  summary: "雨が降りそう",
  urgency: "today",
  dedupeKey: "dedupe-1",
  observedAt: "2026-11-20T00:00:00.000Z",
  status: "queued",
};

function withUrgency(urgency: ProactiveUrgency): ProactiveSignal {
  return { ...signal, urgency };
}

function ciSignal(urgency: ProactiveUrgency): ProactiveSignal {
  return { ...withUrgency(urgency), topic: "ci failure" };
}

function decide(
  urgency: ProactiveUrgency,
  overrides: {
    preferences?: ProactivePreferences;
    defaults?: ProactivePolicyDefaults;
    now?: number;
    publicChannel?: boolean;
    deliveredToday?: number;
  } = {},
) {
  return decideDelivery({
    signal: withUrgency(urgency),
    preferences: overrides.preferences ?? DEFAULT_PROACTIVE_PREFERENCES,
    defaults: overrides.defaults ?? defaults,
    now: overrides.now ?? japanTime(2026, 11, 20, 12, 0),
    publicChannel: overrides.publicChannel ?? false,
    deliveredToday: overrides.deliveredToday ?? 0,
  });
}

test("maps urgencies to delivery modes when nothing restricts them", () => {
  assert.deepEqual(decide("now"), { mode: "interrupt", reason: "urgency-now" });
  assert.deepEqual(decide("today"), { mode: "attach", reason: "default-mode" });
  assert.deepEqual(decide("digest"), { mode: "digest", reason: "urgency-digest" });
  assert.deepEqual(decide("silent"), { mode: "silent", reason: "urgency-silent" });
});

test("uses the default delivery mode for today's signals", () => {
  const preference = (defaultMode: "interrupt" | "attach" | "digest" | "silent") =>
    decide("today", {
      preferences: { ...DEFAULT_PROACTIVE_PREFERENCES, delivery: { defaultMode } },
    });

  assert.deepEqual(preference("attach"), { mode: "attach", reason: "default-mode" });
  assert.deepEqual(preference("digest"), { mode: "digest", reason: "default-mode" });
  assert.deepEqual(preference("silent"), { mode: "silent", reason: "default-mode" });
  assert.deepEqual(preference("interrupt"), { mode: "interrupt", reason: "default-mode" });
  assert.deepEqual(decide("today", { defaults: { ...defaults, defaultMode: "interrupt" } }), {
    mode: "interrupt",
    reason: "default-mode",
  });
  assert.deepEqual(
    decide("today", {
      defaults: { ...defaults, defaultMode: "interrupt" },
      now: japanTime(2026, 11, 20, 23, 30),
    }),
    { mode: "attach", reason: "quiet-hours" },
  );
  assert.deepEqual(
    decide("today", {
      defaults: { ...defaults, defaultMode: "interrupt" },
      deliveredToday: 3,
    }),
    { mode: "attach", reason: "daily-limit" },
  );
});

test("falls back to attach when a digest time is not configured", () => {
  const { digestAt: _digestAt, ...withoutDigestAt } = defaults;
  const digestPreference: ProactivePreferences = {
    ...DEFAULT_PROACTIVE_PREFERENCES,
    delivery: { defaultMode: "digest" },
  };

  assert.deepEqual(decide("digest", { defaults: withoutDigestAt }), {
    mode: "attach",
    reason: "digest-unconfigured",
  });
  assert.deepEqual(decide("today", { defaults: withoutDigestAt, preferences: digestPreference }), {
    mode: "attach",
    reason: "digest-unconfigured",
  });
  assert.deepEqual(
    decide("today", {
      defaults: withoutDigestAt,
      preferences: { ...DEFAULT_PROACTIVE_PREFERENCES, delivery: { digestAt: "09:00" } },
    }),
    { mode: "attach", reason: "default-mode" },
  );
  assert.deepEqual(
    decide("digest", {
      defaults: withoutDigestAt,
      preferences: {
        ...DEFAULT_PROACTIVE_PREFERENCES,
        delivery: { digestAt: "09:00" },
      },
    }),
    { mode: "digest", reason: "urgency-digest" },
  );
});

test("keeps watch signals in public channels but silences other sources", () => {
  assert.deepEqual(decide("now", { publicChannel: true }), {
    mode: "interrupt",
    reason: "urgency-now",
  });

  const memorySignal: ProactiveSignal = {
    ...withUrgency("now"),
    source: { kind: "memory" },
  };
  assert.deepEqual(
    decideDelivery({
      signal: memorySignal,
      preferences: DEFAULT_PROACTIVE_PREFERENCES,
      defaults,
      now: japanTime(2026, 11, 20, 12, 0),
      publicChannel: true,
      deliveredToday: 0,
    }),
    { mode: "silent", reason: "public-channel-disabled" },
  );
  assert.deepEqual(
    decideDelivery({
      signal: memorySignal,
      preferences: DEFAULT_PROACTIVE_PREFERENCES,
      defaults: { ...defaults, publicChannels: true },
      now: japanTime(2026, 11, 20, 12, 0),
      publicChannel: true,
      deliveredToday: 0,
    }),
    { mode: "interrupt", reason: "urgency-now" },
  );
});

test("downgrades every urgency to attach during quiet hours", () => {
  const lateNight = japanTime(2026, 11, 20, 23, 30);

  assert.deepEqual(decide("now", { now: lateNight }), {
    mode: "attach",
    reason: "quiet-hours",
  });
  assert.deepEqual(decide("today", { now: lateNight }), {
    mode: "attach",
    reason: "quiet-hours",
  });
  assert.deepEqual(decide("digest", { now: lateNight }), {
    mode: "attach",
    reason: "quiet-hours",
  });
  assert.deepEqual(decide("silent", { now: lateNight }), {
    mode: "attach",
    reason: "quiet-hours",
  });
  assert.deepEqual(decide("digest", { now: japanTime(2026, 11, 21, 7, 59) }), {
    mode: "attach",
    reason: "quiet-hours",
  });
  assert.deepEqual(decide("digest", { now: japanTime(2026, 11, 21, 8, 0) }), {
    mode: "digest",
    reason: "urgency-digest",
  });
});

test("prefers quiet hours from the preferences over the configured defaults", () => {
  const preferences: ProactivePreferences = {
    ...DEFAULT_PROACTIVE_PREFERENCES,
    delivery: { quietHours: { start: "12:00", end: "13:00" } },
  };

  assert.deepEqual(decide("digest", { preferences, now: japanTime(2026, 11, 20, 12, 30) }), {
    mode: "attach",
    reason: "quiet-hours",
  });
  assert.deepEqual(decide("digest", { preferences, now: japanTime(2026, 11, 20, 23, 30) }), {
    mode: "digest",
    reason: "urgency-digest",
  });

  const emptyQuietHours: ProactivePreferences = {
    ...DEFAULT_PROACTIVE_PREFERENCES,
    delivery: { quietHours: { start: "23:00", end: "23:00" } },
  };
  assert.deepEqual(
    decide("digest", { preferences: emptyQuietHours, now: japanTime(2026, 11, 20, 23, 30) }),
    { mode: "digest", reason: "urgency-digest" },
  );
});

test("keeps non-urgent signals quiet after the daily limit", () => {
  assert.deepEqual(decide("today", { deliveredToday: 3 }), {
    mode: "attach",
    reason: "daily-limit",
  });
  assert.deepEqual(decide("digest", { deliveredToday: 3 }), {
    mode: "attach",
    reason: "daily-limit",
  });
  assert.deepEqual(decide("now", { deliveredToday: 3 }), {
    mode: "interrupt",
    reason: "urgency-now",
  });
  assert.deepEqual(decide("digest", { deliveredToday: 2 }), {
    mode: "digest",
    reason: "urgency-digest",
  });
});

test("prefers the daily limit from the preferences", () => {
  const preferences: ProactivePreferences = {
    ...DEFAULT_PROACTIVE_PREFERENCES,
    delivery: { maxPerDay: 1 },
  };

  assert.deepEqual(decide("digest", { preferences, deliveredToday: 1 }), {
    mode: "attach",
    reason: "daily-limit",
  });
  assert.deepEqual(decide("digest", { preferences, deliveredToday: 0 }), {
    mode: "digest",
    reason: "urgency-digest",
  });
});

test("silences muted topics and expired mutes are ignored", () => {
  const muted: ProactivePreferences = {
    ...DEFAULT_PROACTIVE_PREFERENCES,
    topics: [{ topic: "weather", mode: "mute", until: "2026-12-01" }],
  };

  assert.deepEqual(decide("now", { preferences: muted, now: japanTime(2026, 11, 20, 12, 0) }), {
    mode: "silent",
    reason: "topic-muted",
  });
  assert.deepEqual(decide("now", { preferences: muted, now: japanTime(2026, 12, 1, 23, 59) }), {
    mode: "silent",
    reason: "topic-muted",
  });
  assert.deepEqual(decide("now", { preferences: muted, now: japanTime(2026, 12, 2, 12, 0) }), {
    mode: "interrupt",
    reason: "urgency-now",
  });
});

test("silences urgent-only topics unless the signal is urgent now", () => {
  const preferences: ProactivePreferences = {
    ...DEFAULT_PROACTIVE_PREFERENCES,
    topics: [{ topic: " CI failure ", mode: "urgent-only" }],
  };

  assert.deepEqual(
    decideDelivery({
      signal: ciSignal("now"),
      preferences,
      defaults,
      now: japanTime(2026, 11, 20, 12, 0),
      publicChannel: false,
      deliveredToday: 0,
    }),
    { mode: "interrupt", reason: "urgency-now" },
  );
  assert.deepEqual(
    decideDelivery({
      signal: ciSignal("today"),
      preferences,
      defaults,
      now: japanTime(2026, 11, 20, 12, 0),
      publicChannel: false,
      deliveredToday: 0,
    }),
    { mode: "silent", reason: "urgent-only" },
  );
  assert.deepEqual(
    decideDelivery({
      signal: ciSignal("now"),
      preferences,
      defaults,
      now: japanTime(2026, 11, 20, 23, 30),
      publicChannel: false,
      deliveredToday: 0,
    }),
    { mode: "attach", reason: "quiet-hours" },
  );
});

test("lets allow topics proceed and ignores other topics", () => {
  const preferences: ProactivePreferences = {
    ...DEFAULT_PROACTIVE_PREFERENCES,
    topics: [{ topic: "weather", mode: "allow" }],
  };

  assert.deepEqual(decide("digest", { preferences }), {
    mode: "digest",
    reason: "urgency-digest",
  });
  assert.deepEqual(
    decide("digest", {
      preferences: { ...preferences, topics: [{ topic: "release", mode: "mute" }] },
    }),
    { mode: "digest", reason: "urgency-digest" },
  );
});
