import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import type { Logger } from "pino";

export interface CloudflareTunnel {
  readonly stop: () => Promise<void>;
}

export async function startCloudflareTunnel(
  token: string,
  logger?: Logger,
): Promise<CloudflareTunnel> {
  const env: NodeJS.ProcessEnv = { TUNNEL_TOKEN: token };
  for (const name of ["PATH", "HOME", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }

  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--grace-period", "5s", "run"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stopping = false;
  let closed = false;
  const exited = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      if (!stopping) {
        logger?.error({ event: "cloudflared_exited", code, signal }, "Cloudflare Tunnel exited");
      }
      resolve();
    });
  });

  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      logger?.info(
        { event: "cloudflared_output", output: line.replaceAll(token, "[Redacted]") },
        "Cloudflare Tunnel output",
      );
    });
  }

  try {
    await once(child, "spawn");
  } catch (error) {
    stopping = true;
    await exited;
    throw new Error("Failed to start cloudflared; ensure it is installed and available on PATH", {
      cause: error,
    });
  }
  child.on("error", (error) => {
    logger?.error({ event: "cloudflared_error", err: error }, "Cloudflare Tunnel process error");
  });
  logger?.info({ event: "cloudflared_started" }, "Cloudflare Tunnel process started");

  return {
    stop: async () => {
      if (stopping || closed) return exited;
      stopping = true;
      const timeout = setTimeout(() => child.kill("SIGKILL"), 6_000);
      child.kill("SIGTERM");
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
      logger?.info({ event: "cloudflared_stopped" }, "Cloudflare Tunnel stopped");
    },
  };
}
