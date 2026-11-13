import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import { parseSessionEntries, type FileEntry } from "@earendil-works/pi-coding-agent";

import { createTempDir } from "../../testing/temp-dir";
import { TURN_CONTEXT_CUSTOM_TYPE } from "./pi-turn-context";
import {
  buildLinearBranchBeforeEntry,
  findTurnBoundsForAssistantEntry,
  SentMessageSessionIndex,
  serializeSessionEntriesToJsonl,
  SessionEvalCaseStore,
} from "./session-eval-store";

function createSampleEntries(): FileEntry[] {
  const entries: FileEntry[] = [
    {
      type: "session",
      version: 3,
      id: "sess-1",
      timestamp: "2026-11-01T00:00:00.000Z",
      cwd: "/tmp/original-cwd",
    },
    {
      type: "model_change",
      id: "m1",
      parentId: null,
      timestamp: "2026-11-01T00:00:01.000Z",
      provider: "opencode-go",
      modelId: "deepseek-v4.1-flash",
    },
    {
      type: "custom",
      id: "tc1",
      parentId: "m1",
      timestamp: "2026-11-01T00:00:02.000Z",
      customType: TURN_CONTEXT_CUSTOM_TYPE,
      data: { content: "<user-memory>\nAlice\n</user-memory>" },
    },
    {
      type: "message",
      id: "sys1",
      parentId: "tc1",
      timestamp: "2026-11-01T00:00:03.000Z",
      message: {
        role: "system",
        content: "Old system prompt",
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "u1",
      parentId: "sys1",
      timestamp: "2026-11-01T00:00:04.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "こんにちは" }],
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-11-01T00:00:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "返信前に考える" },
          {
            type: "toolCall",
            id: "call-read-1",
            name: "discord_read",
            arguments: { messageId: "ref-1" },
          },
        ],
        api: "openai-completions",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 3,
      },
    },
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-11-01T00:00:06.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-read-1",
        toolName: "discord_read",
        content: [{ type: "text", text: "過去メッセージ" }],
        isError: false,
        timestamp: 4,
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "tr1",
      timestamp: "2026-11-01T00:00:07.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "送信する" },
          {
            type: "toolCall",
            id: "call-send-1",
            name: "discord_send",
            arguments: { content: "問題の返信メッセージ" },
          },
        ],
        api: "openai-completions",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        usage: {
          input: 20,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 25,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 5,
      },
    },
    {
      type: "message",
      id: "tr2",
      parentId: "a2",
      timestamp: "2026-11-01T00:00:08.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-send-1",
        toolName: "discord_send",
        content: [{ type: "text", text: "Sent message." }],
        details: { messageIds: ["discord-msg-999"] },
        isError: false,
        timestamp: 6,
      },
    },
  ];
  return entries;
}

test("SentMessageSessionIndex persists and reloads records by Discord message ID", async () => {
  await using temp = await createTempDir("klein-eval-index-");
  const index = new SentMessageSessionIndex(temp.path);

  await index.record({
    discordMessageId: "discord-100",
    channelId: "ch-1",
    sessionKey: "discord-channel:ch-1",
    sessionId: "sess-1",
    sessionFile: "/tmp/sess-1.jsonl",
    assistantEntryId: "a2",
    toolResultEntryId: "tr2",
    toolCallId: "call-send-1",
    sentAt: "2026-11-01T00:00:08.000Z",
    content: "テスト送信",
    ownerFeaturesAllowed: false,
  });

  const reloaded = new SentMessageSessionIndex(temp.path);
  const found = await reloaded.findByDiscordMessageId("discord-100");
  assert.ok(found);
  assert.equal(found.assistantEntryId, "a2");
  assert.equal(found.content, "テスト送信");
  assert.equal(await reloaded.findByDiscordMessageId("missing"), undefined);
});

test("buildLinearBranchBeforeEntry slices strictly before target and preserves compaction invariants when dropping system entries", () => {
  const entries = createSampleEntries();
  const sliced = buildLinearBranchBeforeEntry(entries, "a2", { inclusive: false });
  assert.deepEqual(
    sliced.branchEntries.map((e) => e.id),
    ["m1", "tc1", "sys1", "u1", "a1", "tr1"],
  );

  const entriesWithCompaction: FileEntry[] = [
    ...entries.slice(0, 6),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "a1",
      timestamp: "2026-11-01T00:00:06.000Z",
      summary: "Summary",
      firstKeptEntryId: "sys1",
      tokensBefore: 100,
      systemMessage: {
        role: "system",
        content: "Stale checkpoint system",
        timestamp: 1,
      },
    },
    {
      ...entries[6]!,
      parentId: "cmp1",
    } as FileEntry,
    {
      ...entries[7]!,
      parentId: "tr1",
    } as FileEntry,
  ];

  const turnStartSlice = buildLinearBranchBeforeEntry(entriesWithCompaction, "a2", {
    inclusive: false,
    dropSystemMessages: true,
  });
  assert.equal(
    turnStartSlice.branchEntries.some(
      (entry) => entry.type === "message" && entry.message.role === "system",
    ),
    false,
  );
  const compaction = turnStartSlice.branchEntries.find((entry) => entry.type === "compaction");
  assert.ok(compaction && compaction.type === "compaction");
  assert.equal(compaction.firstKeptEntryId, "u1");
  assert.equal(compaction.systemMessage, undefined);
  assert.equal(compaction.parentId, "a1");
});

test("findTurnBoundsForAssistantEntry resolves turnStartEntryId, turnContextEntryId, and discord_send arguments", () => {
  const bounds = findTurnBoundsForAssistantEntry(createSampleEntries(), "a2");
  assert.equal(bounds.turnStartEntryId, "u1");
  assert.equal(bounds.turnContextEntryId, "tc1");
  assert.equal(bounds.assistantTextBeforeCall, "送信する");
  assert.equal(bounds.discordSendContent, "問題の返信メッセージ");
});

test("SessionEvalCaseStore snapshots session up to pre-message boundary on negative emoji and deduplicates", async () => {
  await using temp = await createTempDir("klein-eval-cases-");
  const agentDir = temp.path;
  const sessionDir = join(agentDir, "sessions", encodeURIComponent("discord-channel:ch-1"));
  await mkdir(sessionDir, { recursive: true });
  const sessionFilePath = join(sessionDir, "2026-11-01T00-00-00-000Z_sess-1.jsonl");
  await writeFile(sessionFilePath, serializeSessionEntriesToJsonl(createSampleEntries()), "utf8");

  const index = new SentMessageSessionIndex(agentDir);
  await index.record({
    discordMessageId: "discord-msg-999",
    channelId: "ch-1",
    sessionKey: "discord-channel:ch-1",
    sessionId: "sess-1",
    // Point to non-existent original file path to verify sessions-dir fallback works too.
    sessionFile: join(agentDir, "sessions", "moved.jsonl"),
    assistantEntryId: "a2",
    toolResultEntryId: "tr2",
    toolCallId: "call-send-1",
    sentAt: "2026-11-01T00:00:08.000Z",
    content: "問題の返信メッセージ",
    ownerFeaturesAllowed: false,
  });

  const store = new SessionEvalCaseStore({ agentDir, index });

  // Non-negative emoji should be ignored.
  const positive = await store.recordReactionFeedback({
    emoji: "👍",
    userId: "user-1",
    userIsBot: false,
    channelId: "ch-1",
    messageId: "discord-msg-999",
    occurredAt: "2026-11-02T01:00:00.000Z",
  });
  assert.equal(positive, undefined);

  const recorded = await store.recordReactionFeedback(
    {
      emoji: "👎",
      userId: "owner-1",
      userIsBot: false,
      channelId: "ch-1",
      guildId: "guild-1",
      messageId: "discord-msg-999",
      occurredAt: "2026-11-02T01:05:00.000Z",
    },
    { ownerUserId: "owner-1" },
  );
  assert.ok(recorded);
  assert.equal(recorded.reaction.isOwner, true);
  assert.equal(recorded.slice.upToEntryId, "tr1");
  assert.equal(recorded.slice.targetAssistantEntryId, "a2");
  assert.equal(recorded.slice.turnStartEntryId, "u1");
  assert.equal(recorded.slice.turnContextEntryId, "tc1");
  assert.equal(recorded.recordedResponse.content, "問題の返信メッセージ");

  // Duplicate reaction with same messageId + emoji returns the existing case without creating a second file.
  const duplicate = await store.recordReactionFeedback({
    emoji: "👎",
    userId: "owner-1",
    userIsBot: false,
    channelId: "ch-1",
    messageId: "discord-msg-999",
    occurredAt: "2026-11-02T02:00:00.000Z",
  });
  assert.equal(duplicate?.caseId, recorded.caseId);

  const cases = await store.listCases();
  assert.equal(cases.length, 1);

  const loadedByMsgId = await store.loadCase("discord-msg-999");
  assert.ok(loadedByMsgId);
  assert.equal(loadedByMsgId.caseMeta.caseId, recorded.caseId);
  const parsedSnapshot = parseSessionEntries(await readFile(loadedByMsgId.sessionFilePath, "utf8"));
  assert.equal(
    parsedSnapshot.some((entry) => entry.type !== "session" && entry.id === "a2"),
    false,
  );
  assert.equal(parsedSnapshot.at(-1)?.type !== "session" && parsedSnapshot.at(-1)?.id, "tr1");
});
