import assert from "node:assert/strict";
import test from "node:test";

import type { UserMemory } from "../domain/user-memory";
import { renderFirstSpeakerUserMemory } from "./user-memory-context-renderer";

const identity = { username: "alice", displayName: "Alice" } as const;

function createMemory(overrides: Partial<UserMemory> = {}): UserMemory {
  return {
    discordId: "alice",
    displayName: "Alice",
    summary: "",
    impression: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    facts: "不明",
    history: "なし",
    inCommon: "なし",
    strengthening: "なし",
    ...overrides,
  };
}

test("renders the stored memory of a known user with their name", () => {
  const context = renderFirstSpeakerUserMemory(
    identity,
    createMemory({ summary: "TypeScriptが好きなユーザー", facts: "- 好きなもの: Bun" }),
  );

  assert.match(context, /first message from Alice \(@alice\)/u);
  assert.match(context, /summary: "TypeScriptが好きなユーザー"/u);
  assert.match(context, /## Facts\n\n- 好きなもの: Bun/u);
});

test("treats a memory with only default sections as a first meeting", () => {
  const context = renderFirstSpeakerUserMemory(identity, createMemory());

  assert.match(context, /no stored memory of them yet/u);
  assert.match(context, /first meeting/u);
  assert.doesNotMatch(context, /## Facts/u);
});

test("treats a missing memory as a first meeting", () => {
  const context = renderFirstSpeakerUserMemory(identity, undefined);

  assert.match(context, /no stored memory of them yet/u);
});

test("counts a known profile name as stored memory", () => {
  const context = renderFirstSpeakerUserMemory(identity, createMemory({ nickname: "A" }));

  assert.doesNotMatch(context, /first meeting/u);
  assert.match(context, /nickname: "A"/u);
});
