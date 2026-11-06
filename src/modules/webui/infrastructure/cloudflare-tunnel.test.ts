import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLogger } from "@app/logger";
import { startCloudflareTunnel } from "./cloudflare-tunnel";
import { startWebUi } from "./elysia-webui-app";
import { PiSessionReader } from "./pi-session-reader";
import { PinoJsonlReader } from "./pino-jsonl-reader";

function captureLogs() {
  const events = new EventEmitter();
  const records: Record<string, unknown>[] = [];
  const logger = createLogger({
    destination: {
      write: (line) => {
        const record = JSON.parse(line);
        records.push(record);
        events.emit(record.event, record);
      },
    },
  });
  return { events, logger, records };
}

test("runs cloudflared without forwarding application secrets and stops its process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-tunnel-"));
  const originalPath = process.env.PATH;
  const originalSecret = process.env.KLEIN_TEST_SECRET;
  const { events, logger, records } = captureLogs();
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
    const output = once(events, "cloudflared_output", { signal: AbortSignal.timeout(5_000) });
    tunnel = await startCloudflareTunnel("test-tunnel-token", logger);
    process.env.PATH = originalPath;

    const [record] = await output;
    assert.equal(record.output, "ready:[Redacted]:tunnel --no-autoupdate --grace-period 5s run");
    await tunnel.stop();
    await tunnel.stop();
    assert.ok(records.some((record) => record.output === "stopped"));
    assert.ok(records.some((record) => record.event === "cloudflared_stopped"));
    assert.ok(!records.some((record) => record.event === "cloudflared_exited"));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalSecret === undefined) delete process.env.KLEIN_TEST_SECRET;
    else process.env.KLEIN_TEST_SECRET = originalSecret;
    await tunnel?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports a missing cloudflared executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-tunnel-missing-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = directory;
    await assert.rejects(startCloudflareTunnel("test-tunnel-token"), /Failed to start cloudflared/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("logs an unexpected cloudflared exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-tunnel-exit-"));
  const originalPath = process.env.PATH;
  const { events, logger } = captureLogs();
  try {
    await writeFile(join(directory, "cloudflared"), "#!/bin/sh\nexit 12\n", { mode: 0o700 });
    process.env.PATH = directory;
    const exited = once(events, "cloudflared_exited", { signal: AbortSignal.timeout(5_000) });
    const tunnel = await startCloudflareTunnel("test-tunnel-token", logger);
    process.env.PATH = originalPath;
    const [record] = await exited;
    assert.equal(record.code, 12);
    await tunnel.stop();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("serves local HTTP without a token and releases the listener when tunnel startup fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-webui-tunnel-"));
  const originalPath = process.env.PATH;
  const socket = createServer();
  try {
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const address = socket.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    await writeFile(join(directory, "index.html"), "<html>Klein</html>");
    const options = {
      host: "127.0.0.1",
      port: address.port,
      staticDirectory: directory,
      piSessions: new PiSessionReader(directory),
      pinoLogs: new PinoJsonlReader(directory),
    };
    process.env.PATH = directory;
    const webUi = await startWebUi(options);
    try {
      const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
      assert.deepEqual(await health.json(), { ok: true });
    } finally {
      await webUi.stop();
    }
    await assert.rejects(
      startWebUi({ ...options, tunnelToken: "test-tunnel-token" }),
      /Failed to start cloudflared/,
    );
    socket.listen(address.port, "127.0.0.1");
    await once(socket, "listening");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (socket.listening) await new Promise<void>((resolve) => socket.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
