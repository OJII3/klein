import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  createMcpResultSchema,
  createMcpToolName,
  getMcpToolExposure,
  limitMcpContent,
  LIST_MCP_RESOURCES_TOOL,
  loadMcpConfig,
  loadMcpTools,
  MCP_OUTPUT_MAX_BYTES,
  McpOAuthCredentialStore,
  READ_MCP_RESOURCE_TOOL,
  toModelContent,
  type McpServerConnection,
} from "./pi-durable-mcp";

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

test("loads MCP config with project overrides and validates tool exposure", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "klein-mcp-config-"));
  const agentDir = join(rootDir, "agent");
  const projectDir = join(rootDir, "project");
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        autoEnableCodemode: true,
        mcpServers: {
          "my-docs": {
            url: "https://example.com/mcp",
            exposure: "codemode-deferred",
            toolExposure: {
              "search_*": "direct",
              secret_tool: "hidden",
            },
          },
          my_docs: {
            url: "https://conflict.example.com/mcp",
          },
        },
      }),
    );
    await writeFile(
      join(projectDir, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "my-docs": {
            enabled: false,
            exposure: "deferred",
          },
        },
      }),
    );

    const loaded = loadMcpConfig({ agentDir, cwd: projectDir, projectTrusted: true });
    assert.equal(loaded.autoEnableCodemode, true);
    assert.equal(loaded.servers.length, 1);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0]!, /conflicts with "my-docs"/);

    const server = loaded.servers[0]!;
    assert.equal(server.name, "my-docs");
    assert.equal(server.config.enabled, false);
    assert.equal(server.config.exposure, "deferred");
    assert.equal(getMcpToolExposure(server.config, "search_notes"), "direct");
    assert.equal(getMcpToolExposure(server.config, "secret_tool"), "hidden");
    assert.equal(getMcpToolExposure(server.config, "other_tool"), "deferred");
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test("migrates legacy OAuth store keys and adapts MCP tool schemas and content", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-mcp-oauth-"));
  try {
    const serverUrl = "https://example.com/mcp";
    await writeFile(
      join(agentDir, "mcp-auth.json"),
      JSON.stringify({
        [serverUrl]: {
          tokens: { access_token: "legacy-token", token_type: "Bearer" },
        },
      }),
    );
    const store = new McpOAuthCredentialStore(agentDir).forServer("my-notes", serverUrl);
    const loaded = await store.load();
    assert.equal(loaded?.tokens?.access_token, "legacy-token");

    const rawAfterMigration = JSON.parse(await readFile(join(agentDir, "mcp-auth.json"), "utf8"));
    assert.ok(rawAfterMigration[`mcp__my_notes|${serverUrl}`]);
    assert.equal(rawAfterMigration[serverUrl], undefined);

    const taken = new Set(["mcp__server__tool"]);
    const collidedName = createMcpToolName("server", "tool", (name) => taken.has(name));
    assert.notEqual(collidedName, "mcp__server__tool");
    assert.match(collidedName, /^mcp__server__tool_[0-9a-f]{8}$/);

    const schema = createMcpResultSchema({
      type: "object",
      properties: { item: { $ref: "#/$defs/item" } },
      $defs: { item: { type: "string" } },
    });
    assert.deepEqual((schema.properties as Record<string, unknown>).structuredContent, {
      type: "object",
      properties: { item: { $ref: "#/properties/structuredContent/$defs/item" } },
      $defs: { item: { type: "string" } },
    });

    const converted = await toModelContent(
      "notes",
      [
        {
          type: "resource_link",
          uri: "note://daily/1",
          name: "Daily Note",
          mimeType: "text/markdown",
          size: 2048,
        },
      ],
      { readableResources: true },
    );
    assert.deepEqual(converted, [
      {
        type: "text",
        text: '[Resource note://daily/1 "Daily Note" (text/markdown, 2.0KB). Read it with read_mcp_resource (server "notes")]',
      },
    ]);

    let savedData = "";
    const hugeText = "a".repeat(MCP_OUTPUT_MAX_BYTES + 1024);
    const limited = await limitMcpContent([{ type: "text", text: hugeText }], async (data, ext) => {
      savedData = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      return `/tmp/mock-output${ext}`;
    });
    assert.equal(savedData, hugeText);
    assert.equal(limited.fullOutputPath, "/tmp/mock-output.txt");
    assert.match((limited.content[0] as { text: string }).text, /Warning: truncated output/);
  } finally {
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("exposes MCP resource listing and reading tools when server supports resources", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-mcp-resources-"));
  const connections: McpServerConnection[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { resources: {} },
            serverInfo: { name: "resource-test", version: "1.0.0" },
          }
        : message.method === "resources/list"
          ? {
              resources: [
                { uri: "note://readme", name: "Readme", mimeType: "text/plain" },
                { uri: "ui://hidden-widget", name: "Widget", mimeType: "text/html" },
              ],
            }
          : message.method === "resources/read"
            ? {
                contents: [
                  {
                    uri: message.params.uri,
                    mimeType: "text/plain",
                    text: "Resource body content",
                  },
                ],
              }
            : {};
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;

  try {
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: { docs: { url, exposure: "direct" } },
      }),
    );

    const tools = await loadMcpTools({
      agentDir,
      ownerFeaturesAllowed: true,
      permissions: { mcp: { default: "allow" } },
      logger: pino({ level: "silent" }),
      existingNames: new Set(),
      connections,
    });

    const listTool = tools.find((tool) => tool.name === LIST_MCP_RESOURCES_TOOL);
    const readTool = tools.find((tool) => tool.name === READ_MCP_RESOURCE_TOOL);
    assert.ok(listTool);
    assert.ok(readTool);

    const listed = await listTool.execute({}, {} as never, {} as never);
    assert.deepEqual(listed.structuredOutput, {
      resources: [{ server: "docs", uri: "note://readme", name: "Readme", mimeType: "text/plain" }],
    });

    const read = await readTool.execute(
      { server: "docs", uri: "note://readme" },
      {} as never,
      {} as never,
    );
    assert.deepEqual(read.output, [{ type: "text", text: "Resource body content" }]);
  } finally {
    await Promise.allSettled(connections.map((conn) => conn.close()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("serializes OAuth refresh and file writes across separate credential store instances", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-mcp-lock-"));
  try {
    const serverUrl = "https://example.com/mcp";
    const storeA = new McpOAuthCredentialStore(agentDir);
    const storeB = new McpOAuthCredentialStore(agentDir);

    const serverStoreA = storeA.forServer("shared", serverUrl);
    const serverStoreB = storeB.forServer("shared", serverUrl);
    await serverStoreA.save({
      serverUrl,
      tokens: {
        access_token: "stale-token",
        refresh_token: "refresh-1",
        token_type: "Bearer",
      },
    });

    const events: string[] = [];
    let refreshes = 0;
    const runRefresh = async (label: string, store: typeof serverStoreA) =>
      store.withRefreshLock(async () => {
        events.push(`${label}:start`);
        const current = await store.load();
        if (current?.tokens?.access_token !== "stale-token") {
          events.push(`${label}:reused`);
          return current?.tokens?.access_token;
        }
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        await store.save({
          serverUrl,
          tokens: {
            access_token: "fresh-token",
            refresh_token: "refresh-2",
            token_type: "Bearer",
          },
        });
        events.push(`${label}:refreshed`);
        return "fresh-token";
      });

    const [tokenA, tokenB] = await Promise.all([
      runRefresh("A", serverStoreA),
      runRefresh("B", serverStoreB),
    ]);
    assert.equal(tokenA, "fresh-token");
    assert.equal(tokenB, "fresh-token");
    assert.equal(refreshes, 1);
    assert.deepEqual(events, ["A:start", "A:refreshed", "B:start", "B:reused"]);

    await Promise.all([
      storeA.forServer("alpha", "https://alpha.example.com/mcp").save({
        serverUrl: "https://alpha.example.com/mcp",
        tokens: { access_token: "alpha-token", token_type: "Bearer" },
      }),
      storeB.forServer("beta", "https://beta.example.com/mcp").save({
        serverUrl: "https://beta.example.com/mcp",
        tokens: { access_token: "beta-token", token_type: "Bearer" },
      }),
    ]);

    const alpha = await storeB.forServer("alpha", "https://alpha.example.com/mcp").load();
    const beta = await storeA.forServer("beta", "https://beta.example.com/mcp").load();
    assert.equal(alpha?.tokens?.access_token, "alpha-token");
    assert.equal(beta?.tokens?.access_token, "beta-token");
  } finally {
    await rm(agentDir, { force: true, recursive: true });
  }
});
