import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { createLogger } from "@app/logger";
import { isRecord, parseJson } from "@shared/type-guards";
import { startCloudflareTunnel } from "./cloudflare-tunnel";
import { startWebUi } from "./elysia-webui-app";
import { PiSessionReader } from "./pi-session-reader";
import { PiToolUsageReader } from "./pi-tool-usage-reader";
import { PinoJsonlReader } from "./pino-jsonl-reader";
import { createTempDir } from "../../../testing/temp-dir";

function captureLogs() {
  const records: Record<string, unknown>[] = [];
  const waiters = new Map<string, ((record: Record<string, unknown>) => void)[]>();
  const logger = createLogger({
    destination: {
      write: (line) => {
        const parsed = parseJson(line);
        if (!isRecord(parsed)) return;
        records.push(parsed);
        if (typeof parsed.event !== "string") return;
        const callbacks = waiters.get(parsed.event);
        if (!callbacks || callbacks.length === 0) return;
        waiters.delete(parsed.event);
        for (const callback of callbacks) callback(parsed);
      },
    },
  });
  const waitFor = (eventName: string, timeoutMs = 5_000): Promise<Record<string, unknown>> => {
    const existing = records.find((item) => item.event === eventName);
    if (existing) return Promise.resolve(existing);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for log event: ${eventName}`));
      }, timeoutMs);
      const callbacks = waiters.get(eventName) ?? [];
      callbacks.push((record) => {
        clearTimeout(timer);
        resolve(record);
      });
      waiters.set(eventName, callbacks);
    });
  };
  return { logger, records, waitFor };
}

test("runs cloudflared without forwarding application secrets and stops its process", async () => {
  await using temp = await createTempDir("klein-tunnel-");
  const directory = temp.path;
  const originalPath = process.env.PATH;
  const originalSecret = process.env.KLEIN_TEST_SECRET;
  const { logger, records, waitFor } = captureLogs();
  let tunnel: Awaited<ReturnType<typeof startCloudflareTunnel>> | undefined;

  try {
    await writeFile(
      join(directory, "cloudflared"),
      `#!/bin/sh
trap 'echo stopped; exit 0' TERM
if [ -n "$KLEIN_TEST_SECRET$DISCORD_BOT_TOKEN" ]; then echo secrets-forwarded; fi
printf 'ready:%s:%s\n' "$TUNNEL_TOKEN" "$*"
while :; do /bin/sleep 1; done
`,
      { mode: 0o700 },
    );
    process.env.PATH = directory;
    process.env.KLEIN_TEST_SECRET = "must-not-be-forwarded";
    const output = waitFor("cloudflared_output");
    tunnel = await startCloudflareTunnel("test-tunnel-token", logger);
    process.env.PATH = originalPath;

    const record = await output;
    assert.equal(record.output, "ready:[Redacted]:tunnel --no-autoupdate --grace-period 5s run");
    await tunnel.stop();
    await tunnel.stop();
    assert.ok(records.some((entry) => entry.output === "stopped"));
    assert.ok(records.some((entry) => entry.event === "cloudflared_stopped"));
    assert.ok(!records.some((entry) => entry.event === "cloudflared_exited"));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalSecret === undefined) delete process.env.KLEIN_TEST_SECRET;
    else process.env.KLEIN_TEST_SECRET = originalSecret;
    await tunnel?.stop();
  }
});

test("reports a missing cloudflared executable", async () => {
  await using temp = await createTempDir("klein-tunnel-missing-");
  const directory = temp.path;
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = directory;
    await assert.rejects(startCloudflareTunnel("test-tunnel-token"), /Failed to start cloudflared/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("requires a tunnel token when cloudflared is enabled", async () => {
  await using temp = await createTempDir("klein-webui-token-");
  await assert.rejects(
    startWebUi({
      displayName: "Klein",
      host: "127.0.0.1",
      port: 1,
      staticDirectory: temp.path,
      cloudflaredEnabled: true,
      piSessions: new PiSessionReader(temp.path),
      pinoLogs: new PinoJsonlReader(temp.path),
      toolUsage: new PiToolUsageReader(temp.path),
    }),
    /TUNNEL_TOKEN is required/,
  );
});

test("logs an unexpected cloudflared exit", async () => {
  await using temp = await createTempDir("klein-tunnel-exit-");
  const directory = temp.path;
  const originalPath = process.env.PATH;
  const { logger, waitFor } = captureLogs();
  try {
    await writeFile(join(directory, "cloudflared"), "#!/bin/sh\nexit 12\n", { mode: 0o700 });
    process.env.PATH = directory;
    const exited = waitFor("cloudflared_exited");
    const tunnel = await startCloudflareTunnel("test-tunnel-token", logger);
    process.env.PATH = originalPath;
    const record = await exited;
    assert.equal(record.code, 12);
    await tunnel.stop();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("serves local HTTP when cloudflared is disabled and releases the listener when tunnel startup fails", async () => {
  await using temp = await createTempDir("klein-webui-tunnel-");
  const directory = temp.path;
  const originalPath = process.env.PATH;
  const socket = createServer();
  try {
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const address = socket.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((resolve) => {
      socket.close(() => {
        resolve();
      });
    });
    await writeFile(join(directory, "index.html"), "<html>Klein</html>");
    await mkdir(join(directory, "assets"), { recursive: true });
    await writeFile(join(directory, "assets", "app.js"), "console.log('klein')");
    const options = {
      displayName: "Klein",
      host: "127.0.0.1",
      port: address.port,
      staticDirectory: directory,
      tunnelToken: "test-tunnel-token",
      piSessions: new PiSessionReader(directory),
      pinoLogs: new PinoJsonlReader(directory),
      toolUsage: new PiToolUsageReader(directory),
    };
    process.env.PATH = directory;
    const webUi = await startWebUi(options);
    try {
      const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
      assert.deepEqual(parseJson(await health.text()), { ok: true });

      const index = await fetch(`http://127.0.0.1:${address.port}/`);
      assert.equal(index.headers.get("cache-control"), "no-store");
      assert.equal(await index.text(), "<html>Klein</html>");

      // A rebuild replaces index.html while the process keeps running. The
      // next request must serve the new document instead of a startup copy.
      await writeFile(join(directory, "index.html"), "<html>Klein rebuilt</html>");
      const rebuilt = await fetch(`http://127.0.0.1:${address.port}/sessions`);
      assert.equal(rebuilt.headers.get("cache-control"), "no-store");
      assert.equal(await rebuilt.text(), "<html>Klein rebuilt</html>");

      const asset = await fetch(`http://127.0.0.1:${address.port}/assets/app.js`);
      assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

      await assert.rejects(
        startWebUi(options),
        /Failed to start server|EADDRINUSE/i,
        "a second instance must not share the port",
      );
    } finally {
      await webUi.stop();
    }
    await assert.rejects(
      startWebUi({ ...options, cloudflaredEnabled: true }),
      /Failed to start cloudflared/,
    );
    socket.listen(address.port, "127.0.0.1");
    await once(socket, "listening");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (socket.listening) {
      await new Promise<void>((resolve) => {
        socket.close(() => {
          resolve();
        });
      });
    }
  }
});
