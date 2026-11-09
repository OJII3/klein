import assert from "node:assert/strict";
import test from "node:test";

import { createPiSessionManager } from "@runtime/pi/pi-agent-runtime";
import { EstimatedUsageProvider } from "./estimated-usage-provider";
import { createTempDir } from "../../../testing/temp-dir";

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

test("estimates the current month's provider spend from session usage", async () => {
  await using temp = await createTempDir("klein-provider-usage-");
  const agentDirectory = temp.path;

  const sessionManager = createPiSessionManager(
    agentDirectory,
    "discord-channel:123",
    "new",
    process.cwd(),
  );
  appendAssistantMessage(sessionManager, "google", 1.234, SEP_10);
  appendAssistantMessage(sessionManager, "google", 0.5, Date.UTC(2026, 7, 31));
  appendAssistantMessage(sessionManager, "mistral", 2, SEP_10);

  const provider = new EstimatedUsageProvider(
    agentDirectory,
    "google",
    10,
    () => new Date("2026-09-14T14:00:00.000Z"),
  );

  assert.deepEqual(await provider.getMonthlyUsageLimit(), {
    resetsAt: new Date(Date.UTC(2026, 9)),
    status: "ok",
    usedPercentage: (1.234 / 10) * 100,
  });
});
