import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runMcpCommand } from "./mcp-cli";

const ACCESS_TOKEN = "signed-in-token";
const AUTHORIZATION_CODE = "test-code";

interface OAuthMcpServer {
  url: string;
  origin: string;
  close: () => Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * An MCP server that answers 401 until it receives the token its authorization server issues, plus
 * the authorization server itself (protected resource metadata, authorization server metadata,
 * authorization and token endpoints) on the same origin.
 */
async function startOAuthMcpServer(): Promise<OAuthMcpServer> {
  let origin = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/mcp" && request.method === "POST") {
      if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        response
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
        return;
      }
      const message = JSON.parse(await readBody(request));
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-test", version: "1.0.0" },
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
            : { content: [{ type: "text", text: "Signed-in note" }] };
      json(response, 200, { jsonrpc: "2.0", id: message.id, result });
      return;
    }
    if (url.pathname === "/mcp") {
      // No server-to-client stream.
      response.writeHead(405).end();
      return;
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? `${origin}/callback`);
      redirect.searchParams.set("code", AUTHORIZATION_CODE);
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: redirect.href }).end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const params = new URLSearchParams(await readBody(request));
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), AUTHORIZATION_CODE);
      json(response, 200, {
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

interface Workspace {
  root: string;
  configPath: string;
  agentDir: string;
}

async function createWorkspace(mcpUrl: string): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "klein-mcp-cli-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const configPath = join(root, "config.jsonc");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      llm: { provider: "opencode-go", model: "test-model" },
      runtime: { agentDir },
      discord: { access: { default: "deny", directMessages: "deny" } },
      features: { memory: { enabled: false }, minecraft: { enabled: false } },
    }),
  );
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: { docs: { url: mcpUrl, oauth: { clientId: "klein-test" } } },
    }),
  );
  return { root, configPath, agentDir };
}

async function withWorkspace(
  mcpUrl: string,
  run: (workspace: Workspace) => Promise<void>,
): Promise<void> {
  const workspace = await createWorkspace(mcpUrl);
  const previous = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = workspace.configPath;
  try {
    await run(workspace);
  } finally {
    if (previous === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = previous;
    await rm(workspace.root, { force: true, recursive: true });
  }
}

/** Follow the authorization endpoint's redirect to the loopback callback, as the browser would. */
async function visitAuthorizationUrl(authorizationUrl: string): Promise<string> {
  const authorization = await fetch(authorizationUrl, { redirect: "manual" });
  const redirectUrl = authorization.headers.get("location");
  assert.ok(redirectUrl, `the authorization endpoint did not redirect (${authorization.status})`);
  const callback = await fetch(redirectUrl);
  assert.equal(callback.status, 200);
  return redirectUrl;
}

test("mcp login signs in through the loopback callback", async () => {
  const server = await startOAuthMcpServer();
  try {
    await withWorkspace(server.url, async (workspace) => {
      const logs: string[] = [];
      const errors: string[] = [];
      const browserVisits: string[] = [];
      const code = await runMcpCommand(["login", "docs"], {
        log: (message) => logs.push(message),
        error: (message) => errors.push(message),
        openUrl: (url) => {
          // Give the sign-in a moment to wait for the callback, like a browser loading a page would.
          setTimeout(() => {
            visitAuthorizationUrl(url).then(
              () => browserVisits.push(url),
              (error: unknown) => errors.push(String(error)),
            );
          }, 20);
        },
      });

      assert.equal(code, 0, errors.join("\n"));
      assert.equal(browserVisits.length, 1);
      assert.ok(logs.includes('Signed in to MCP server "docs" (1 tools).'), logs.join("\n"));
      const stored = JSON.parse(await readFile(join(workspace.agentDir, "mcp-auth.json"), "utf8"));
      assert.equal(stored[`mcp__docs|${server.url}`]?.tokens?.access_token, ACCESS_TOKEN);

      // A second sign-in reuses the stored token instead of starting the browser flow again.
      const again: string[] = [];
      assert.equal(
        await runMcpCommand(["login", "docs"], {
          log: (message) => again.push(message),
          error: (message) => errors.push(message),
          openUrl: (url) => {
            throw new Error(`unexpected browser sign-in: ${url}`);
          },
        }),
        0,
      );
      assert.ok(
        again.includes('Already signed in to MCP server "docs" (1 tools).'),
        again.join("\n"),
      );
      assert.deepEqual(errors, []);
    });
  } finally {
    await server.close();
  }
});

test("mcp login accepts a pasted redirect URL when the browser cannot reach the callback", async () => {
  const server = await startOAuthMcpServer();
  try {
    await withWorkspace(server.url, async (workspace) => {
      const errors: string[] = [];
      let authorizationUrl: string | undefined;
      const code = await runMcpCommand(["login", "docs"], {
        log: () => undefined,
        error: (message) => errors.push(message),
        openUrl: (url) => {
          authorizationUrl = url;
        },
        promptForRedirectUrl: async () => {
          assert.ok(authorizationUrl, "the authorization URL must be shown before the prompt");
          return visitAuthorizationUrl(authorizationUrl);
        },
      });

      assert.equal(code, 0, errors.join("\n"));
      const stored = JSON.parse(await readFile(join(workspace.agentDir, "mcp-auth.json"), "utf8"));
      assert.equal(stored[`mcp__docs|${server.url}`]?.tokens?.access_token, ACCESS_TOKEN);
    });
  } finally {
    await server.close();
  }
});

test("mcp login reports usage for a missing server name", async () => {
  const errors: string[] = [];
  const code = await runMcpCommand([], {
    log: () => undefined,
    error: (message) => errors.push(message),
  });
  assert.equal(code, 2);
  assert.deepEqual(errors, ["Usage: klein mcp login <server>"]);
});
