import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
import {
  McpOAuthAuthorizationRequiredError,
  type McpOAuthState,
  type OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";

import { createPiDurableAgentFactory } from "./pi-durable-agent-runtime";
import {
  createMcpAuthProvider,
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
    runtime = await factory.create({ systemPrompt: "Read notes when requested." }, [], {
      sessionKey: "discord-channel:durable-mcp",
      ownerFeaturesAllowed: true,
    });
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

async function lockDirectories(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".lock"));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runWorker(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited with ${code}: ${stderr}`));
    });
  });
}

test("serializes OAuth credential writes across processes", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-mcp-process-"));
  const workers = 3;
  const writesPerWorker = 10;
  const moduleUrl = new URL("./pi-durable-mcp.ts", import.meta.url).href;
  const script = `
import { McpOAuthCredentialStore } from ${JSON.stringify(moduleUrl)};
const [agentDir, worker] = process.argv.slice(1);
const store = new McpOAuthCredentialStore(agentDir);
for (let index = 0; index < ${writesPerWorker}; index += 1) {
  const url = "https://example.com/" + worker + "/" + index;
  await store.forServer("srv" + worker + "_" + index, url).save({
    serverUrl: url,
    tokens: { access_token: worker + "-" + index, token_type: "Bearer" },
  });
}
`;
  try {
    await Promise.all(
      Array.from({ length: workers }, (_, worker) => runWorker(script, [agentDir, String(worker)])),
    );
    const states = JSON.parse(await readFile(join(agentDir, "mcp-auth.json"), "utf8"));
    assert.equal(Object.keys(states).length, workers * writesPerWorker);
    assert.deepEqual(await lockDirectories(agentDir), []);
  } finally {
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("takes over a credential lock left by a crashed process", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-mcp-stale-"));
  try {
    const lockDir = join(agentDir, "mcp-auth.json.lock");
    await mkdir(lockDir);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);

    const started = Date.now();
    const state = await new McpOAuthCredentialStore(agentDir)
      .forServer("crashed", "https://example.com/mcp")
      .load();
    assert.equal(state, undefined);
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(await lockDirectories(agentDir), []);
  } finally {
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("does not remove a lock another store took over as stale", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-mcp-lock-owner-"));
  const serverUrl = "https://example.com/mcp";
  const first = new McpOAuthCredentialStore(agentDir).forServer("shared", serverUrl);
  const second = new McpOAuthCredentialStore(agentDir).forServer("shared", serverUrl);
  const firstAcquired = deferred();
  const firstRelease = deferred();
  const secondAcquired = deferred();
  const secondRelease = deferred();
  let lockDir: string | undefined;

  try {
    const firstRun = first.withRefreshLock(async () => {
      const lockName = (await readdir(agentDir)).find((name) =>
        name.startsWith("mcp-auth-refresh-"),
      );
      assert.ok(lockName);
      lockDir = join(agentDir, lockName);
      const old = new Date(Date.now() - 60_000);
      await utimes(lockDir, old, old);
      firstAcquired.resolve();
      await firstRelease.promise;
    });
    await firstAcquired.promise;

    const secondRun = second.withRefreshLock(async () => {
      secondAcquired.resolve();
      await secondRelease.promise;
    });
    await secondAcquired.promise;

    firstRelease.resolve();
    await firstRun;
    assert.ok(lockDir && existsSync(lockDir), "the second holder's lock must stay");

    secondRelease.resolve();
    await secondRun;
    assert.deepEqual(await lockDirectories(agentDir), []);
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await rm(agentDir, { force: true, recursive: true });
  }
});

function oauthState(serverUrl: string, overrides: Partial<McpOAuthState> = {}): McpOAuthState {
  return {
    serverUrl,
    clientInformation: { client_id: "klein", redirect_uris: ["http://127.0.0.1/callback"] },
    discovery: {
      authorizationServerUrl: "https://auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      },
    },
    tokens: { access_token: "stale-token", refresh_token: "refresh-1", token_type: "Bearer" },
    ...overrides,
  };
}

function tokenEndpointFetch(
  requests: RequestInit[],
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    assert.equal(String(input), "https://auth.example.com/token");
    requests.push(init ?? {});
    return Response.json({
      access_token: "fresh-token",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 3600,
    });
  };
}

test("refreshes an expired MCP OAuth token before a request", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-mcp-refresh-"));
  const serverUrl = "https://mcp.example.com/mcp";
  const requests: RequestInit[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = tokenEndpointFetch(requests) as typeof fetch;
  try {
    const store = new McpOAuthCredentialStore(agentDir).forServer("remote", serverUrl);
    await store.save(oauthState(serverUrl, { tokensExpireAt: Date.now() - 1_000 }));
    const provider = createMcpAuthProvider({
      serverUrl,
      store,
      settings: () => ({}),
      onChallenge: () => undefined,
    });

    assert.equal(await provider.token(), "fresh-token");
    assert.equal(requests.length, 1);
    assert.match(String(requests[0]?.body), /grant_type=refresh_token/);
    assert.equal((await store.load())?.tokens?.refresh_token, "refresh-2");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("refreshes an MCP OAuth token once after concurrent 401 responses", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-mcp-401-"));
  const serverUrl = "https://mcp.example.com/mcp";
  try {
    const store = new McpOAuthCredentialStore(agentDir).forServer("remote", serverUrl);
    await store.save(oauthState(serverUrl));
    const requests: RequestInit[] = [];
    const challenges: OAuthChallenge[] = [];
    const provider = createMcpAuthProvider({
      serverUrl,
      store,
      settings: () => ({}),
      onChallenge: (challenge) => challenges.push(challenge),
    });

    assert.equal(await provider.token(), "stale-token");
    const context = {
      response: new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer error="invalid_token"' },
      }),
      serverUrl: new URL(serverUrl),
      fetch: tokenEndpointFetch(requests),
      token: "stale-token",
    };
    await Promise.all([provider.onUnauthorized!(context), provider.onUnauthorized!(context)]);

    assert.equal(requests.length, 1);
    assert.deepEqual(
      challenges.map((challenge) => challenge.error),
      ["invalid_token", "invalid_token"],
    );
    assert.equal(await provider.token(), "fresh-token");
    assert.equal((await store.load())?.tokens?.refresh_token, "refresh-2");
  } finally {
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("requires a new sign-in when the server asks for more scope", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-mcp-scope-"));
  const serverUrl = "https://mcp.example.com/mcp";
  try {
    const store = new McpOAuthCredentialStore(agentDir).forServer("remote", serverUrl);
    await store.save(oauthState(serverUrl));
    const challenges: OAuthChallenge[] = [];
    const provider = createMcpAuthProvider({
      serverUrl,
      store,
      settings: () => ({}),
      onChallenge: (challenge) => challenges.push(challenge),
    });

    await assert.rejects(
      provider.onUnauthorized!({
        response: new Response(null, {
          status: 403,
          headers: {
            "www-authenticate": 'Bearer error="insufficient_scope", scope="files:write"',
          },
        }),
        serverUrl: new URL(serverUrl),
        fetch: async () => {
          throw new Error("a scope upgrade must not refresh silently");
        },
        token: "stale-token",
      }),
      McpOAuthAuthorizationRequiredError,
    );
    assert.equal(challenges[0]?.error, "insufficient_scope");
    assert.equal(challenges[0]?.scope, "files:write");
    assert.equal(await provider.token(), "stale-token");
  } finally {
    await rm(agentDir, { force: true, recursive: true });
  }
});
