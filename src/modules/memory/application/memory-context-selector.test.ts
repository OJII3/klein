import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryDocument, MemoryEntry } from "../domain/memory";
import { selectMemoryEntries } from "./memory-context-selector";

test("keeps every rule and selects related non-rule entries", () => {
  const document = createDocument([
    createEntry("rule-1", "rule", "画像ルール", "画像には必ず説明を付ける"),
    createEntry("fact-1", "fact", "定例会", "定例会は毎週土曜日に開催する"),
    createEntry(
      "procedure-1",
      "procedure",
      "デプロイ手順",
      "本番デプロイは release ブランチから行う",
    ),
    createEntry("rule-2", "rule", "投稿ルール", "機密情報を投稿しない"),
    createEntry("fact-2", "fact", "雑談", "好きな食べ物はカレー"),
  ]);

  const selected = selectMemoryEntries(document, "土曜日の定例会について教えて");

  assert.deepEqual(
    selected.entries.map((entry) => entry.id),
    ["rule-1", "rule-2", "fact-1"],
  );
});

test("returns rules even when there is no searchable query", () => {
  const document = createDocument([
    createEntry("rule-1", "rule", "投稿ルール", "機密情報を投稿しない"),
    createEntry("fact-1", "fact", "定例会", "毎週土曜日"),
  ]);

  const selected = selectMemoryEntries(document, "");

  assert.deepEqual(
    selected.entries.map((entry) => entry.id),
    ["rule-1"],
  );
});

test("limits related entries after ranking them", () => {
  const document = createDocument([
    createEntry("fact-1", "fact", "定例会", "毎週土曜日に開催する"),
    createEntry("fact-2", "fact", "土曜日の会場", "定例会の会場はホール"),
    createEntry("fact-3", "fact", "土曜日の予定", "土曜日は休み"),
  ]);

  const selected = selectMemoryEntries(document, "土曜日の定例会", {
    maxRelatedEntries: 2,
  });

  assert.deepEqual(
    selected.entries.map((entry) => entry.id),
    ["fact-1", "fact-2"],
  );
});

function createDocument(entries: readonly MemoryEntry[]): MemoryDocument {
  return { entries };
}

function createEntry(
  id: string,
  kind: MemoryEntry["kind"],
  title: string,
  content: string,
): MemoryEntry {
  return {
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    kind,
    sourceMessageIds: [],
    title,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
