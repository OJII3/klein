import assert from "node:assert/strict";
import test from "node:test";

import {
  type ExtensionContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { isRecord } from "@shared/type-guards";
import {
  type BackgroundCompactionPreparation,
  createBackgroundCompactionExtension,
} from "./background-compaction";
import {
  createStubAssistantMessage,
  createStubCompactionPreparation,
  createStubExtensionContext,
  createStubModel,
  createStubSessionBeforeCompactEvent,
  createStubTurnEndEvent,
  createStubUsage,
  createTestModelRegistry,
  loadTestExtension,
} from "./pi-test-helpers";

test("defers edited messages to standard compaction before summarizing", async () => {
  const sessionManager = createTestSession();
  const firstEntry = sessionManager.getBranch()[0];
  assert.ok(firstEntry);
  sessionManager.appendContextEdit(firstEntry.id, { content: "replacement" });
  let summarizeCalls = 0;
  const ext = await loadTestExtension(
    createBackgroundCompactionExtension(createTestSettings(), {
      summarize: async () => {
        summarizeCalls += 1;
        return undefined;
      },
    }),
  );

  const turnEnd = ext.handlers.get("turn_end")?.[0];
  assert.ok(turnEnd);
  await turnEnd(createStubTurnEndEvent(), createTestContext(sessionManager));

  assert.equal(summarizeCalls, 0);
});

test("discards a background summary when a summarized message is omitted", async () => {
  const sessionManager = createTestSession();
  let preparation: BackgroundCompactionPreparation | undefined;
  let backgroundSignal: AbortSignal | undefined;
  const ext = await loadTestExtension(
    createBackgroundCompactionExtension(createTestSettings(), {
      summarize: async (nextPreparation, _context, signal) => {
        preparation = nextPreparation;
        backgroundSignal = signal;
        return {
          summary: "stale summary",
          firstKeptEntryId: nextPreparation.firstKeptEntryId,
          tokensBefore: nextPreparation.tokensBefore,
        };
      },
    }),
  );
  const context = createTestContext(sessionManager);
  const turnEnd = ext.handlers.get("turn_end")?.[0];
  assert.ok(turnEnd);
  await turnEnd(createStubTurnEndEvent(), context);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.ok(preparation);
  const firstEntry = sessionManager.getBranch()[0];
  assert.ok(firstEntry);
  sessionManager.appendContextEdit(firstEntry.id, null);

  const beforeCompact = ext.handlers.get("session_before_compact")?.[0];
  assert.ok(beforeCompact);
  const result = await beforeCompact(
    createStubSessionBeforeCompactEvent({
      preparation,
      branchEntries: sessionManager.getBranch(),
    }),
    context,
  );

  assert.equal(result, undefined);
  assert.equal(backgroundSignal?.aborted, true);
});

test("cancels background work after an edit even below the compaction threshold", async () => {
  const sessionManager = createTestSession();
  let backgroundSignal: AbortSignal | undefined;
  const ext = await loadTestExtension(
    createBackgroundCompactionExtension(createTestSettings(), {
      summarize: async (_preparation, _context, signal) => {
        backgroundSignal = signal;
        return undefined;
      },
    }),
  );
  const context = createTestContext(sessionManager);
  const turnEnd = ext.handlers.get("turn_end")?.[0];
  assert.ok(turnEnd);
  void turnEnd(createStubTurnEndEvent(), context);
  assert.equal(backgroundSignal?.aborted, false);
  const firstEntry = sessionManager.getBranch()[0];
  assert.ok(firstEntry);
  sessionManager.appendContextEdit(firstEntry.id, null);
  context.getContextUsage = () => ({ tokens: 0, contextWindow: 1000, percent: 0 });

  void turnEnd(createStubTurnEndEvent(), context);

  assert.equal(backgroundSignal?.aborted, true);
});

test("uses characterName in handoff compaction prompt and summary", async () => {
  const sessionManager = createTestSession();
  const capturedSystemPrompts: string[] = [];
  const ext = await loadTestExtension(
    createBackgroundCompactionExtension(createTestSettings(), {
      handoff: {
        instructions: "handoff",
        characterName: "月見ヤチヨ",
      },
    }),
  );
  const secondEntry = sessionManager.getBranch()[1];
  assert.ok(secondEntry);
  const modelRegistry = createTestModelRegistry();
  modelRegistry.complete = async (_model, input) => {
    capturedSystemPrompts.push(input.systemPrompt ?? "");
    return createStubAssistantMessage({
      content: [{ type: "text", text: "- 継続する話題" }],
      usage: createStubUsage({ input: 10, output: 5, totalTokens: 15 }),
    });
  };
  const context = createStubExtensionContext({
    sessionManager,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 1000, percent: 100 }),
    model: createStubModel(),
    modelRegistry,
  });

  const beforeCompact = ext.handlers.get("session_before_compact")?.[0];
  assert.ok(beforeCompact);
  const result = await beforeCompact(
    createStubSessionBeforeCompactEvent({
      customInstructions: "handoff",
      preparation: createStubCompactionPreparation({
        firstKeptEntryId: secondEntry.id,
        settings: createTestSettings().getCompactionSettings(),
      }),
      branchEntries: sessionManager.getBranch(),
    }),
    context,
  );

  assert.match(
    capturedSystemPrompts[0] ?? "",
    /^あなたは月見ヤチヨの次セッション向け引き継ぎメモを作ります。/,
  );
  assert.ok(isRecord(result) && isRecord(result.compaction));
  assert.equal(
    result.compaction.summary,
    "## Goal\n月見ヤチヨとして振る舞う\n\n## 引き継ぎ\n- 継続する話題",
  );
});

function createTestSettings(): SettingsManager {
  return SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 150 },
  });
}

function createTestSession(): SessionManager {
  const sessionManager = SessionManager.inMemory();
  for (let index = 0; index < 4; index += 1) {
    sessionManager.appendMessage({
      role: "user",
      content: `message ${index} `.repeat(100),
      timestamp: Date.now(),
    });
  }
  return sessionManager;
}

function createTestContext(sessionManager: SessionManager): ExtensionContext {
  return createStubExtensionContext({
    sessionManager,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 1000, percent: 100 }),
  });
}
