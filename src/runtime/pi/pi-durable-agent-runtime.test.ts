import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";

import {
  fauxAssistantMessage,
  fauxProvider,
  getCurrentTools,
  InMemoryCredentialStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { createPiDurableAgentFactory } from "./pi-durable-agent-runtime";
import type { AgentRuntime } from "@agents/core/agent-runtime";

test("imports every legacy Pi session and resumes the latest durable conversation", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-pi-durable-migration-"));
  const legacyAgentDir = join(agentDir, "legacy");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const provider = fauxProvider({ tokensPerSecond: 100_000 });
  const model = provider.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const sessionKey = "discord-channel:migration";
  const legacySessionDir = join(legacyAgentDir, "sessions", encodeURIComponent(sessionKey));
  const legacy = SessionManager.create(process.cwd(), legacySessionDir);
  legacy.appendMessage({ role: "user", content: "Previous conversation", timestamp: 10 });
  legacy.appendMessage(fauxAssistantMessage("Previous reply"));
  await utimes(
    legacy.getSessionFile()!,
    new Date(Date.now() - 60_000),
    new Date(Date.now() - 60_000),
  );
  const latest = SessionManager.create(process.cwd(), legacySessionDir);
  latest.appendMessage({ role: "user", content: "Latest conversation", timestamp: 20 });
  latest.appendMessage(fauxAssistantMessage("Latest reply"));
  const factory = createPiDurableAgentFactory({
    agentDir: join(agentDir, "durable"),
    legacyAgentDir,
    modelRuntime,
    sessionMode: "resume",
    llm: { provider: model.provider, model: model.id },
    logger: pino({ level: "silent" }),
  });

  try {
    const runtime = (await factory.create(
      { systemPrompt: "Test system prompt", toolNames: [] },
      [],
      { sessionKey },
    )) as AgentRuntime & { compactForHandoff(): Promise<string> };
    const requests: TranscriptContext[] = [];
    provider.setResponses([
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("Acknowledged");
      },
    ]);
    await runtime.prompt({
      id: "migration-event",
      type: "reminder.due",
      source: "reminder",
      occurredAt: "2026-10-14T09:30:42.123Z",
      content: [{ type: "text", text: "Continue from the latest conversation" }],
    });
    const activeTools = getCurrentTools(requests[0]!.messages).map((tool) => tool.name);
    assert.ok(activeTools.includes("web_search"));
    assert.ok(activeTools.includes("source_check"));
    assert.ok(activeTools.includes("fetch_content"));
    const resumedText = requests[0]!.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    assert.match(resumedText, /Latest conversation/);
    assert.doesNotMatch(resumedText, /Previous conversation/);
    const sessions = await factory.sessions.list();
    assert.equal(sessions.items.length, 2);
    const latestSession = sessions.items.find(
      (session) => session.firstMessage === "Latest conversation",
    );
    const previousSession = sessions.items.find(
      (session) => session.firstMessage === "Previous conversation",
    );
    assert.ok(latestSession);
    assert.ok(previousSession);
    const detail = await factory.sessions.get(latestSession.id);
    assert.ok(detail);
    assert.ok(detail.items.some((item) => item.summary === "Latest conversation"));
    assert.ok(detail.items.some((item) => item.summary === "Latest reply"));

    provider.setResponses([
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("- 次の会話で続ける");
      },
    ]);
    const handoff = await runtime.compactForHandoff();
    assert.match(handoff, /次の会話で続ける/);
    const summaryRequest = requests[1]!;
    const summaryPrompt = summaryRequest.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    assert.match(summaryPrompt, /Continue from the latest conversation/);
    assert.doesNotMatch(summaryPrompt, /Acknowledged/);
    runtime.dispose();
  } finally {
    await factory.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { force: true, recursive: true });
  }
});
