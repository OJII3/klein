import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPiSessionManager } from "@runtime/pi/pi-agent-runtime";
import { MistralEstimatedUsageProvider } from "./mistral-estimated-usage-provider";

const SEP_10 = Date.UTC(2026, 8, 10);

function appendAssistantMessage(
  sessionManager: ReturnType<typeof createPiSessionManager>,
  provider: string,
  totalCost: number,
  timestamp: number,
): void {
  sessionManager.appendMessage({
    role: "assistant",
    content: "hello",
    api: "mistral-conversations",
    provider,
    model: "deepseek-v4-1-flash-1017",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
    },
    stopReason: "stop",
    timestamp,
  } as never);
}

test("estimates the current month's Mistral spend from session usage", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "klein-mistral-usage-"));

  try {
    const sessionManager = createPiSessionManager(
      agentDirectory,
      "discord-channel:123",
      "new",
      process.cwd(),
    );
    appendAssistantMessage(sessionManager, "mistral", 1.234, SEP_10);
    appendAssistantMessage(sessionManager, "mistral", 0.5, Date.UTC(2026, 7, 31));
    appendAssistantMessage(sessionManager, "opencode-go", 2, SEP_10);

    const provider = new MistralEstimatedUsageProvider(
      agentDirectory,
      () => new Date("2026-09-14T14:00:00.000Z"),
    );

    assert.deepEqual(await provider.getMonthlyUsageLimit(), {
      kind: "cost",
      resetsAt: new Date(Date.UTC(2026, 9)),
      status: "ok",
      usedAmount: 1.234,
      currency: "USD",
    });
  } finally {
    await rm(agentDirectory, { force: true, recursive: true });
  }
});
