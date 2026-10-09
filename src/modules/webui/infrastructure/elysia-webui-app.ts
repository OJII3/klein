import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { staticPlugin } from "@elysia/static";

import { createWebUiApp } from "./webui-api";
import type { WebUiDependencies } from "../ports/webui";
import { startCloudflareTunnel, type CloudflareTunnel } from "./cloudflare-tunnel";

export { createWebUiApp };
export type { WebUiDependencies };

export interface WebUiServerOptions extends WebUiDependencies {
  readonly host: string;
  readonly port: number;
  readonly staticDirectory: string;
  readonly tunnelToken?: string;
}

export interface WebUiServer {
  readonly stop: () => Promise<void>;
}

export type WebUiApp = ReturnType<typeof createWebUiApp>;

export async function startWebUi(options: WebUiServerOptions): Promise<WebUiServer> {
  const staticApp = await staticPlugin({
    assets: resolve(options.staticDirectory),
    alwaysStatic: true,
    bunFullstack: false,
    indexHTML: true,
    prefix: "/",
  });
  const app = createWebUiApp(options)
    .get("/:view", async ({ params, set }) => {
      if (params.view !== "logs" && params.view !== "sessions" && params.view !== "memory") {
        set.status = 404;
        return { error: "Not found" };
      }
      return new Response(await readFile(resolve(options.staticDirectory, "index.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    })
    .use(staticApp);

  app.listen({ hostname: options.host, port: options.port });
  let tunnel: CloudflareTunnel | undefined;
  try {
    if (options.tunnelToken) {
      tunnel = await startCloudflareTunnel(options.tunnelToken, options.logger);
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
