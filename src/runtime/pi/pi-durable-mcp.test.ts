import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createPiDurableAgentFactory } from "./pi-durable-agent-runtime";

test("calls a configured MCP tool through the durable runtime", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-pi-durable-mcp-"));
  const methods: string[] = [];
  const authorizationHeaders: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.headers.authorization) authorizationHeaders.push(request.headers.authorization);
    const message = JSON.parse(body);
    if (message.method) methods.push(message.method);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "durable-test", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "read_note",
                  description: "Read a note",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : { content: [{ type: "text", text: "Durable vault note" }] };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const provider = fauxProvider({ tokensPerSecond: 100_000 });
  const model = provider.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const factory = createPiDurableAgentFactory({
    agentDir: join(agentDir, "durable"),
    configDir: agentDir,
    llm: { provider: model.provider, model: model.id },
    modelRuntime,
    sessionMode: "new",
    permissions: { mcp: { default: "allow" } },
    logger: pino({ level: "silent" }),
  });
  let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;

  try {
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: { notes: { url, exposure: "direct" } },
      }),
    );
    await writeFile(
      join(agentDir, "mcp-auth.json"),
      JSON.stringify({
        [`mcp__notes|${url}`]: {
          tokens: { access_token: "durable-test-token", token_type: "Bearer" },
        },
      }),
    );
    runtime = await factory.create(
      { systemPrompt: "Read notes when requested.", toolNames: [] },
      [],
      { sessionKey: "discord-channel:durable-mcp", ownerFeaturesAllowed: true },
    );
    const requests: TranscriptContext[] = [];
    provider.setResponses([
      (context) => {
        requests.push(context);
        return fauxAssistantMessage(fauxToolCall("mcp__notes__read_note", {}), {
          stopReason: "toolUse",
        });
      },
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("Read complete");
      },
    ]);
    await runtime.prompt({
      id: "mcp-event",
      type: "reminder.due",
      source: "reminder",
      occurredAt: "2026-10-14T09:30:42.123Z",
      content: [{ type: "text", text: "Read a note" }],
    });

    const result = requests[1]?.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "mcp__notes__read_note",
    );
    assert.ok(
      result && result.role === "toolResult",
      JSON.stringify({
        methods,
        requests: requests.map((request) => request.messages.map((message) => message.role)),
      }),
    );
    assert.deepEqual(result.content, [{ type: "text", text: "Durable vault note" }]);
    assert.ok(methods.includes("initialize"));
    assert.ok(methods.includes("tools/call"));
    assert.ok(authorizationHeaders.every((header) => header === "Bearer durable-test-token"));
  } finally {
    runtime?.dispose();
    await factory.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(agentDir, { force: true, recursive: true });
  }
});
