import assert from "node:assert/strict";
import test from "node:test";

import {
  SettingsManager,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  type BackgroundCompactionPreparation,
  createBackgroundCompactionExtension,
  shouldStartBackgroundCompaction,
} from "./background-compaction.js";
import { resolveConfiguredModel } from "./pi-agent-runtime.js";

test("resolves a configured built-in model", () => {
  const model = resolveConfiguredModel("opencode-go", "kimi-k3");

  assert.equal(model.provider, "opencode-go");
  assert.equal(model.id, "kimi-k3");
});

test("rejects an unknown configured model", () => {
  assert.throws(
    () => resolveConfiguredModel("opencode-go", "does-not-exist"),
    /Configured Pi model was not found: opencode-go\/does-not-exist/,
  );
});

test("starts background compaction before the built-in threshold", async () => {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 150 },
  });
  const sessionManager = createTestSession();
  let preparation: BackgroundCompactionPreparation | undefined;
  let summarizeCalls = 0;

  const handlers = registerExtension(
    createBackgroundCompactionExtension(settingsManager, {
      leadTokens: 0,
      summarize: async (nextPreparation) => {
        preparation = nextPreparation;
        summarizeCalls += 1;
        return {
          summary: "prepared summary",
          firstKeptEntryId: nextPreparation.firstKeptEntryId,
          tokensBefore: nextPreparation.tokensBefore,
        };
      },
    }),
  );
  const context = createTestContext(sessionManager);

  handlers.get("turn_end")?.({} as never, context);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(summarizeCalls, 1);
  assert.ok(preparation);

  const result = handlers.get("session_before_compact")?.(
    {
      preparation,
      branchEntries: sessionManager.getBranch(),
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    } as never,
    context,
  ) as { compaction?: { summary: string; tokensBefore: number } } | undefined;

  assert.equal(result?.compaction?.summary, "prepared summary");
  assert.equal(result?.compaction?.tokensBefore, 1000);
});

test("falls back to built-in compaction while background summary is pending", async () => {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 150 },
  });
  const sessionManager = createTestSession();
  let preparation: BackgroundCompactionPreparation | undefined;
  let backgroundSignal: AbortSignal | undefined;
  let releaseSummary!: () => void;

  const handlers = registerExtension(
    createBackgroundCompactionExtension(settingsManager, {
      leadTokens: 0,
      summarize: async (nextPreparation, _context, signal) => {
        preparation = nextPreparation;
        backgroundSignal = signal;
        await new Promise<void>((resolve) => {
          releaseSummary = resolve;
        });
        return undefined;
      },
    }),
  );
  const context = createTestContext(sessionManager);

  handlers.get("turn_end")?.({} as never, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(preparation);

  const result = handlers.get("session_before_compact")?.(
    {
      preparation,
      branchEntries: sessionManager.getBranch(),
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    } as never,
    context,
  );

  assert.equal(result, undefined);
  assert.equal(backgroundSignal?.aborted, true);
  releaseSummary();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("starts before Pi's compaction threshold", () => {
  assert.equal(shouldStartBackgroundCompaction(700, 1000, 100, 100), false);
  assert.equal(shouldStartBackgroundCompaction(800, 1000, 100, 100), true);
});

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

function createTestContext(sessionManager: SessionManager): ExtensionContext {
  return {
    sessionManager,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 1000, percent: 100 }),
  } as unknown as ExtensionContext;
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
