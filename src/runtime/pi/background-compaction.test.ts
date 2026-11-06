import assert from "node:assert/strict";
import test from "node:test";

import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  type BackgroundCompactionPreparation,
  createBackgroundCompactionExtension,
} from "./background-compaction";

test("defers edited messages to standard compaction before summarizing", () => {
  const sessionManager = createTestSession();
  const firstEntry = sessionManager.getBranch()[0];
  assert.ok(firstEntry);
  sessionManager.appendContextEdit(firstEntry.id, { content: "replacement" });
  let summarizeCalls = 0;
  const handlers = registerExtension(
    createBackgroundCompactionExtension(createTestSettings(), {
      summarize: async () => {
        summarizeCalls += 1;
        return undefined;
      },
    }),
  );

  handlers.get("turn_end")?.({} as never, createTestContext(sessionManager));

  assert.equal(summarizeCalls, 0);
});

test("discards a background summary when a summarized message is omitted", async () => {
  const sessionManager = createTestSession();
  let preparation: BackgroundCompactionPreparation | undefined;
  let backgroundSignal: AbortSignal | undefined;
  const handlers = registerExtension(
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
  handlers.get("turn_end")?.({} as never, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(preparation);
  const firstEntry = sessionManager.getBranch()[0];
  assert.ok(firstEntry);
  sessionManager.appendContextEdit(firstEntry.id, null);

  const result = handlers.get("session_before_compact")?.(
    { preparation, branchEntries: sessionManager.getBranch() } as never,
    context,
  );

  assert.equal(result, undefined);
  assert.equal(backgroundSignal?.aborted, true);
});

test("cancels background work after an edit even below the compaction threshold", () => {
  const sessionManager = createTestSession();
  let backgroundSignal: AbortSignal | undefined;
  const handlers = registerExtension(
    createBackgroundCompactionExtension(createTestSettings(), {
      summarize: async (_preparation, _context, signal) => {
        backgroundSignal = signal;
        return undefined;
      },
    }),
  );
  const context = createTestContext(sessionManager);
  handlers.get("turn_end")?.({} as never, context);
  assert.equal(backgroundSignal?.aborted, false);
  const firstEntry = sessionManager.getBranch()[0];
  assert.ok(firstEntry);
  sessionManager.appendContextEdit(firstEntry.id, null);
  context.getContextUsage = () => ({ tokens: 0, contextWindow: 1000, percent: 0 });

  handlers.get("turn_end")?.({} as never, context);

  assert.equal(backgroundSignal?.aborted, true);
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
  return {
    sessionManager,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 1000, percent: 100 }),
  } as unknown as ExtensionContext;
}

function registerExtension(extension: ReturnType<typeof createBackgroundCompactionExtension>) {
  type Handler = (event: never, context: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  extension(api);
  return handlers;
}
