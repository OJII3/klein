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
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { AgentRuntime } from "@agents/core/agent-runtime";
import { DISCORD_AGENT_TOOL_NAMES } from "@agents/discord/prompt-policy";
import { createPiAgentFactory, createPiSessionManager } from "./pi-agent-runtime";

for (const sessionMode of ["new", "resume"] as const) {
  test(`discovers and calls authenticated MCP tools in ${sessionMode} sessions`, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "klein-mcp-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const methods: string[] = [];
    const authorization: Array<string | undefined> = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      authorization.push(request.headers.authorization);
      if (request.headers.authorization !== "Bearer test-vault-token") {
        response.writeHead(401).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      methods.push(message.method);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "test-obsidian", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "read_note",
                    description: "Read notes in the Obsidian vault",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : { content: [{ type: "text", text: "Vault note content" }] };
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
    let runtime: AgentRuntime | undefined;

    try {
      await writeFile(
        join(agentDir, "mcp.json"),
        JSON.stringify({ mcpServers: { obsidian: { url, exposure: "deferred" } } }),
      );
      await writeFile(
        join(agentDir, "mcp-auth.json"),
        JSON.stringify({
          [`mcp__obsidian|${url}`]: {
            tokens: { access_token: "test-vault-token", token_type: "Bearer" },
          },
        }),
      );
      const sessionKey = "discord-channel:mcp-test";
      const previousSession = createPiSessionManager(agentDir, sessionKey, "new");
      previousSession.appendMessage({
        role: "user",
        content: "Previous conversation",
        timestamp: Date.now(),
      });
      previousSession.appendMessage(fauxAssistantMessage("Previous reply"));
      const factory = createPiAgentFactory({
        agentDir,
        llm: { provider: model.provider, model: model.id },
        logger: pino({ level: "silent" }),
        modelRuntime,
        sessionMode,
      });
      runtime = await factory.create(
        { systemPrompt: "Read vault notes when requested.", toolNames: DISCORD_AGENT_TOOL_NAMES },
        [],
        { sessionKey },
      );
      const requests: TranscriptContext[] = [];
      provider.setResponses([
        (context) => {
          requests.push(context);
          return fauxAssistantMessage(
            fauxToolCall("tool_search", { query: "obsidian vault notes" }),
          );
        },
        (context) => {
          requests.push(context);
          return fauxAssistantMessage(fauxToolCall("mcp__obsidian__read_note", {}));
        },
        (context) => {
          requests.push(context);
          return fauxAssistantMessage("Finished");
        },
      ]);

      await runtime.prompt({ text: "Read an Obsidian note", images: [] });

      assert.match(getCurrentSystemPrompt(requests[0].messages), /mcp__obsidian/);
      assert.equal(
        requests[0].messages.some(
          (message) => message.role === "user" && message.content === "Previous conversation",
        ),
        sessionMode === "resume",
      );
      assert.ok(
        getCurrentTools(requests[1].messages).some(
          (tool) => tool.name === "mcp__obsidian__read_note",
        ),
      );
      const result = requests[2].messages.find(
        (message) =>
          message.role === "toolResult" && message.toolName === "mcp__obsidian__read_note",
      );
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.isError, false);
      assert.deepEqual(result.content, [{ type: "text", text: "Vault note content" }]);
      assert.ok(methods.includes("initialize"));
      assert.ok(methods.includes("tools/call"));
      assert.ok(authorization.every((header) => header === "Bearer test-vault-token"));
    } finally {
      runtime?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(agentDir, { force: true, recursive: true });
    }
  });
}
