import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { staticPlugin } from "@elysia/static";
import type { Logger } from "pino";

import { createWebUiApp, type WebUiApp, type WebUiDependencies } from "@klein/webui-api";

import { MemoryEntryNotFoundError } from "@modules/memory/domain/memory";
import { startCloudflareTunnel, type CloudflareTunnel } from "./cloudflare-tunnel";

export { createWebUiApp };
export type { WebUiApp, WebUiDependencies };

export interface WebUiServerOptions extends WebUiDependencies {
  readonly host: string;
  readonly port: number;
  readonly staticDirectory: string;
  readonly cloudflaredEnabled?: boolean;
  readonly tunnelToken?: string;
  readonly logger?: Logger;
}

export interface WebUiServer {
  readonly stop: () => Promise<void>;
}

const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
// Never reuse the HTML document: behind Cloudflare Access a cached document can
// outlive its Access session, leaving the browser to load auth-blocked assets
// (a blank page) instead of being redirected to the Access login.
const HTML_CACHE_CONTROL = "no-store";

export async function createWebUiServerApp(options: WebUiServerOptions) {
  const staticApp = await staticPlugin({
    assets: resolve(options.staticDirectory),
    alwaysStatic: true,
    bunFullstack: false,
    // The SPA entry point is served below so that every request reads the
    // current index.html instead of a copy cached at startup.
    indexHTML: false,
    prefix: "/",
  });
  // Read on every request: a running process must serve the index that matches
  // the assets currently on disk, even after a rebuild.
  const serveIndex = async () =>
    new Response(await readFile(resolve(options.staticDirectory, "index.html")), {
      headers: {
        "cache-control": HTML_CACHE_CONTROL,
        "content-type": "text/html; charset=utf-8",
      },
    });
  return createWebUiApp({
    ...options,
    isMemoryEntryNotFoundError:
      options.isMemoryEntryNotFoundError ?? ((error) => error instanceof MemoryEntryNotFoundError),
  })
    .onAfterHandle(({ request, set }) => {
      const { pathname } = new URL(request.url);
      // Vite fingerprints everything under /assets, so those are immutable.
      // Everything else (the HTML entry point and SPA routes) must not be stored.
      set.headers["cache-control"] = pathname.startsWith("/assets/")
        ? IMMUTABLE_ASSET_CACHE_CONTROL
        : HTML_CACHE_CONTROL;
      if (!pathname.startsWith("/api/")) {
        options.logger?.info(
          {
            event: "webui_request",
            method: request.method,
            path: pathname,
            status: set.status,
            userAgent: request.headers.get("user-agent"),
          },
          "Web UI request",
        );
      }
    })
    .get("/", serveIndex)
    .get("/*", async ({ request, set }) => {
      const { pathname } = new URL(request.url);
      // Unknown API and asset paths stay 404s. Every other GET is an SPA route,
      // so the client router owns which paths exist.
      if (pathname === "/api" || pathname.startsWith("/api/") || pathname.includes(".")) {
        set.status = 404;
        return { error: "Not found" };
      }
      return serveIndex();
    })
    .use(staticApp);
}

export async function startWebUi(options: WebUiServerOptions): Promise<WebUiServer> {
  const tunnelToken = options.cloudflaredEnabled ? options.tunnelToken : undefined;
  if (options.cloudflaredEnabled && !tunnelToken) {
    throw new Error("TUNNEL_TOKEN is required when features.webui.cloudflared.enabled is true");
  }

  const app = await createWebUiServerApp(options);

  // Elysia enables SO_REUSEPORT by default, which lets a second Klein instance
  // bind the same port and silently split traffic between old and new builds.
  app.listen({ hostname: options.host, port: options.port, reusePort: false });
  let tunnel: CloudflareTunnel | undefined;
  try {
    if (tunnelToken) {
      tunnel = await startCloudflareTunnel(tunnelToken, options.logger);
    }
  } catch (error) {
    await app.stop();
    throw error;
  }
  options.logger?.info(
    {
      event: "webui_started",
      host: options.host,
      port: options.port,
    },
    "Web UI started",
  );

  return {
    stop: async () => {
      await tunnel?.stop();
      await app.stop();
      options.logger?.info({ event: "webui_stopped" }, "Web UI stopped");
    },
  };
}
