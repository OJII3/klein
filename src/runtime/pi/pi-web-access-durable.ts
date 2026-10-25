import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineTool,
  type Conversation,
  type JsonObject,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { rewriteFxtwitterFetchInput } from "./fxtwitter-fetch";

export async function createPiWebAccessTools(options: {
  agentDir: string;
  modelRegistry: ModelRegistry;
  model: unknown;
  logger: Logger;
  getConversation(): Promise<Conversation>;
}): Promise<{
  tools: ToolDefinition[];
  activate(conversation: Conversation): Promise<void>;
  executionContext(): Promise<unknown>;
  flushEntries(): Promise<void>;
  dispose(): void;
}> {
  process.env.PI_CODING_AGENT_DIR = resolve(options.agentDir);
  const extensionModule = (await import(
    pathToFileURL(resolve(process.cwd(), "node_modules/pi-web-access/index.ts")).href
  )) as { default: (extensionApi: never) => void };
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>();
  let active = true;
  let pendingEntries = Promise.resolve();
  const enqueueEntry = (operation: () => Promise<void>, kind: string): void => {
    pendingEntries = pendingEntries.then(operation).catch((error: unknown) => {
      options.logger.warn(
        { err: error, event: "pi_web_access_entry_failed", kind },
        "Failed to persist pi-web-access entry",
      );
    });
  };
  const appendEntry = (kind: string, data: unknown): void => {
    if (!active) return;
    enqueueEntry(async () => {
      const conversation = await options.getConversation();
      const submission = await conversation.submit(
        { type: "write", entry: { kind: `klein.web_access.${kind}`, data: data as JsonObject } },
        BACKGROUND_CONTEXT,
      );
      await submission.wait(BACKGROUND_CONTEXT);
    }, kind);
  };
  const sendMessage = (
    message: { content: unknown; customType?: string; display?: boolean },
    settings?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
  ): void => {
    if (!active) return;
    enqueueEntry(async () => {
      const conversation = await options.getConversation();
      const content = message.content as never;
      const entry = {
        kind: "klein.web_access.message",
        data: {
          customType: message.customType ?? "web-access",
          display: message.display ?? false,
        },
      };
      const submission = settings?.triggerTurn
        ? await conversation.submit(
            { type: "input", content, whenBusy: settings.deliverAs ?? "followUp", entry },
            BACKGROUND_CONTEXT,
          )
        : await conversation.submit(
            {
              type: "write",
              entry: { ...entry, model: [{ role: "user", content, timestamp: Date.now() }] },
            },
            BACKGROUND_CONTEXT,
          );
      await submission.wait(BACKGROUND_CONTEXT);
    }, "message");
  };
  const extensionApi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    on(event: string, handler: (event: unknown, context: unknown) => unknown) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    appendEntry,
    sendMessage,
    exec: async () => {
      throw new Error("Shell access is unavailable in Klein's pi-durable runtime");
    },
    registerCommand() {},
    registerShortcut() {},
  };
  extensionModule.default(extensionApi as never);

  const context = async (conversation: Conversation) => {
    const state = await conversation.context(BACKGROUND_CONTEXT);
    return {
      cwd: process.cwd(),
      mode: "rpc",
      hasUI: false,
      model: options.model,
      modelRegistry: options.modelRegistry,
      isProjectTrusted: () => true,
      sessionManager: {
        getBranch: () =>
          state.entries.map((entry) => ({
            type: "custom",
            customType: entry.kind.replace(/^klein\.web_access\./, ""),
            data: entry.data,
          })),
      },
      ui: new Proxy({}, { get: () => () => undefined }),
    };
  };
  return {
    tools,
    async executionContext() {
      return context(await options.getConversation());
    },
    flushEntries() {
      return pendingEntries;
    },
    async activate(conversation) {
      const eventContext = await context(conversation);
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({}, eventContext);
      }
    },
    dispose() {
      if (!active) return;
      active = false;
      for (const handler of handlers.get("session_shutdown") ?? []) {
        void Promise.resolve(handler({}, {})).catch((error: unknown) => {
          options.logger.warn(
            { err: error, event: "pi_web_access_shutdown_failed" },
            "pi-web-access cleanup failed",
          );
        });
      }
    },
  };
}

export function adaptPiWebAccessTools(
  tools: readonly ToolDefinition[],
  isToolAllowed: (name: string) => boolean,
  executionContext: () => Promise<unknown>,
  flushEntries: () => Promise<void>,
): ToolRegistration[] {
  return tools
    .filter((tool) => isToolAllowed(tool.name))
    .map((tool) =>
      defineTool({
        name: tool.name,
        description: [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])]
          .filter(Boolean)
          .join("\n\n"),
        parameters: tool.parameters,
        structuredOutputSchema: tool.outputSchema,
        deferred: tool.exposure === "deferred" ? true : undefined,
        replay: "unsafe",
        async execute(args, api, context) {
          if (tool.name === "fetch_content") {
            rewriteFxtwitterFetchInput(args as Record<string, unknown>);
          }
          const piContext = await executionContext();
          const result = await tool
            .execute(api.callId, args as never, context.abortSignal, undefined, piContext as never)
            .finally(flushEntries);
          return {
            output: result.content as never,
            structuredOutput: result.structuredContent as never,
            isError: result.isError,
            details: result.details as never,
          };
        },
      }),
    );
}
