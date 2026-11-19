import assert from "node:assert/strict";

import { test } from "bun:test";

import {
  DEFAULT_PROACTIVE_PREFERENCES,
  parseProactivePreferences,
  renderProactivePreferences,
  updateProactivePreferences,
  type ProactivePreferences,
} from "./proactive-preference";

const documentedMarkdown = [
  "# Proactive preferences",
  "",
  "## Delivery",
  "- default: attach",
  "- quiet_hours: 23:00-08:00",
  "- digest_at: 09:00",
  "- max_per_day: 3",
  "",
  "## Topics",
  "- weather: mute until 2026-12-01",
  "- CI failure: allow urgent",
  "- release: mute",
  "",
  "## Notes",
  "- 作業中は短く。リンクは求められたときだけ。",
  "",
].join("\n");

const documentedPreferences: ProactivePreferences = {
  delivery: {
    defaultMode: "attach",
    quietHours: { start: "23:00", end: "08:00" },
    digestAt: "09:00",
    maxPerDay: 3,
  },
  topics: [
    { topic: "weather", mode: "mute", until: "2026-12-01" },
    { topic: "CI failure", mode: "urgent-only" },
    { topic: "release", mode: "mute" },
  ],
  notes: ["作業中は短く。リンクは求められたときだけ。"],
};

test("parses the documented preferences file", () => {
  assert.deepEqual(parseProactivePreferences(documentedMarkdown), documentedPreferences);
});

test("renders the documented preferences file", () => {
  assert.equal(renderProactivePreferences(documentedPreferences), documentedMarkdown);
});

test("round-trips default preferences through the template", () => {
  const markdown = renderProactivePreferences(DEFAULT_PROACTIVE_PREFERENCES);
  assert.deepEqual(parseProactivePreferences(markdown), DEFAULT_PROACTIVE_PREFERENCES);
  assert.equal(
    markdown,
    ["# Proactive preferences", "", "## Delivery", "", "## Topics", "", "## Notes", ""].join("\n"),
  );
});

test("ignores malformed lines, unknown sections, and unknown keys", () => {
  const markdown = [
    "# Proactive preferences",
    "",
    "## Delivery",
    "- default: shout",
    "- max_per_day: -1",
    "- digest_at: 9:00",
    "- quiet_hours: 25:00-08:00",
    "- timezone: Asia/Tokyo",
    "",
    "## Unknown",
    "- default: silent",
    "- weather: mute",
    "",
    "## Topics",
    "- weather: scream",
    "- release: mute until 2026-13-01",
    "- CI failure: allow",
    "- other: allow urgent",
    "",
    "## Notes",
    "- keep this",
    "not a note",
    "",
  ].join("\n");

  assert.deepEqual(parseProactivePreferences(markdown), {
    delivery: {},
    topics: [
      { topic: "CI failure", mode: "allow" },
      { topic: "other", mode: "urgent-only" },
    ],
    notes: ["keep this"],
  });
});

test("keeps the last duplicate topic and normalizes headings", () => {
  const markdown = [
    "## delivery",
    "- digest_at: 09:00",
    "- DEFAULT: digest",
    "",
    "## TOPICS",
    "- weather: allow",
    "- weather: mute until 2026-12-01",
    "",
    "## notes",
    "- メモ",
  ].join("\n");

  assert.deepEqual(parseProactivePreferences(markdown), {
    delivery: { defaultMode: "digest", digestAt: "09:00" },
    topics: [{ topic: "weather", mode: "mute", until: "2026-12-01" }],
    notes: ["メモ"],
  });
});

test("updates delivery values while keeping unknown lines, sections, and notes", () => {
  const markdown = [
    "# Proactive preferences",
    "",
    "## Delivery",
    "- timezone: Asia/Tokyo",
    "- default: attach",
    "",
    "## Topics",
    "- release: mute",
    "",
    "## Notes",
    "- 残すメモ",
    "",
    "## Free",
    "- 未知の節",
    "",
  ].join("\n");

  const updated = updateProactivePreferences(markdown, {
    kind: "set_delivery",
    key: "default",
    value: "interrupt",
  });
  assert.match(updated, /- timezone: Asia\/Tokyo/u);
  assert.match(updated, /- default: interrupt/u);
  assert.match(updated, /- release: mute/u);
  assert.match(updated, /- 残すメモ/u);
  assert.match(updated, /## Free\n- 未知の節/u);

  const withLimits = updateProactivePreferences(updated, {
    kind: "set_delivery",
    key: "max_per_day",
    value: "05",
  });
  const withQuietHours = updateProactivePreferences(withLimits, {
    kind: "set_delivery",
    key: "quiet_hours",
    value: "22:30 - 07:30",
  });
  const withDigest = updateProactivePreferences(withQuietHours, {
    kind: "set_delivery",
    key: "digest_at",
    value: "08:15",
  });

  assert.deepEqual(parseProactivePreferences(withDigest), {
    delivery: {
      defaultMode: "interrupt",
      quietHours: { start: "22:30", end: "07:30" },
      digestAt: "08:15",
      maxPerDay: 5,
    },
    topics: [{ topic: "release", mode: "mute" }],
    notes: ["残すメモ"],
  });
});

test("creates missing sections and replaces or removes only known topic lines", () => {
  const markdown = ["# Proactive preferences", "", "## Notes", "- 既存", ""].join("\n");

  const withTopic = updateProactivePreferences(markdown, {
    kind: "set_topic",
    topic: "weather",
    mode: "mute",
    until: "2026-12-01",
  });
  assert.match(withTopic, /## Topics\n- weather: mute until 2026-12-01/u);
  assert.match(withTopic, /## Notes\n- 既存/u);

  const replaced = updateProactivePreferences(withTopic, {
    kind: "set_topic",
    topic: "Weather",
    mode: "urgent-only",
  });
  assert.equal(replaced.match(/^- Weather:/gmu)?.length, 1);
  assert.doesNotMatch(replaced, /weather: mute/u);

  const withSecondTopic = updateProactivePreferences(replaced, {
    kind: "set_topic",
    topic: "release",
    mode: "allow",
  });
  const removed = updateProactivePreferences(withSecondTopic, {
    kind: "remove_topic",
    topic: " weather ",
  });

  assert.deepEqual(parseProactivePreferences(removed).topics, [
    { topic: "release", mode: "allow" },
  ]);
});

test("adds notes without duplicates and removes only the requested note", () => {
  const markdown = [
    "# Proactive preferences",
    "",
    "## Notes",
    "- 既存のメモ",
    "- 残すメモ",
    "",
  ].join("\n");

  const added = updateProactivePreferences(markdown, {
    kind: "add_note",
    text: " 新しい\nメモ ",
  });
  const duplicated = updateProactivePreferences(added, {
    kind: "add_note",
    text: "新しい メモ",
  });
  assert.equal(duplicated.match(/^- 新しい メモ$/gmu)?.length, 1);

  const removed = updateProactivePreferences(duplicated, {
    kind: "remove_note",
    text: "既存のメモ",
  });
  assert.deepEqual(parseProactivePreferences(removed).notes, ["残すメモ", "新しい メモ"]);
});

test("creates the requested section when updating an empty file", () => {
  const updated = updateProactivePreferences("", {
    kind: "set_delivery",
    key: "default",
    value: "silent",
  });

  assert.match(updated, /^# Proactive preferences\n/u);
  assert.match(updated, /## Delivery\n- default: silent/u);
});

test("rejects invalid preference changes", () => {
  assert.throws(
    () =>
      updateProactivePreferences("", {
        kind: "set_delivery",
        key: "default",
        value: "shout",
      }),
    /配信方法/u,
  );
  assert.throws(
    () =>
      updateProactivePreferences("", {
        kind: "set_delivery",
        key: "quiet_hours",
        value: "25:00-08:00",
      }),
    /静かな時間/u,
  );
  assert.throws(
    () =>
      updateProactivePreferences("", {
        kind: "set_delivery",
        key: "digest_at",
        value: "9:00",
      }),
    /まとめる時刻/u,
  );
  assert.throws(
    () =>
      updateProactivePreferences("", {
        kind: "set_delivery",
        key: "max_per_day",
        value: "-1",
      }),
    /1日の上限/u,
  );
  assert.throws(
    () =>
      updateProactivePreferences("", {
        kind: "set_topic",
        topic: " ",
        mode: "mute",
      }),
    /話題/u,
  );
  assert.throws(
    () =>
      updateProactivePreferences("", {
        kind: "set_topic",
        topic: "weather",
        mode: "mute",
        until: "2026-13-01",
      }),
    /期限/u,
  );
  assert.throws(() => updateProactivePreferences("", { kind: "add_note", text: " " }), /メモ/u);
});
