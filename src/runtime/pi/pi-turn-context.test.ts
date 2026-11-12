import assert from "node:assert/strict";
import test from "node:test";

import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  createTurnContextExtension,
  renderTurnContext,
  TURN_CONTEXT_CUSTOM_TYPE,
} from "./pi-turn-context";

test("renders turn context in a stable order", () => {
  assert.equal(
    renderTurnContext({
      ownerMemory: "owner context",
      userMemory: "user context",
      guildMemory: "guild context",
      channelRule: "channel rule",
    }),
    [
      "<owner-memory>\nowner context\n</owner-memory>",
      "<user-memory>\nuser context\n</user-memory>",
      "<guild-memory>\nguild context\n</guild-memory>",
      "<channel-rule>\nchannel rule\n</channel-rule>",
    ].join("\n\n"),
  );
});

test("renders nothing for an empty turn context", () => {
  assert.equal(renderTurnContext({}), undefined);
});

test("injects the newest turn context before the last user message", async () => {
  const messages: ContextEvent["messages"] = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "user", content: "second", timestamp: 2 },
  ];
  const handler = registerExtension(createTurnContextExtension()).get("context")!;
  const result = (await handler(
    { type: "context", messages } as never,
    createContext([turnContextEntry("guild context")]),
  )) as { messages: ContextEvent["messages"] };

  assert.equal(result.messages.length, 3);
  assert.deepEqual(result.messages[0], messages[0]);
  assert.deepEqual(result.messages[1], {
    role: "custom",
    customType: TURN_CONTEXT_CUSTOM_TYPE,
    content: "guild context",
    display: false,
    timestamp: result.messages[1]?.timestamp,
  });
  assert.deepEqual(result.messages[2], messages[1]);
});

test("drops older turn context messages and clears context for an empty entry", async () => {
  const messages: ContextEvent["messages"] = [
    { role: "user", content: "first", timestamp: 1 },
    {
      role: "custom",
      customType: TURN_CONTEXT_CUSTOM_TYPE,
      content: "old context",
      display: false,
      timestamp: 2,
    },
    { role: "user", content: "second", timestamp: 3 },
  ];
  const handler = registerExtension(createTurnContextExtension()).get("context")!;
  const result = (await handler(
    { type: "context", messages } as never,
    createContext([turnContextEntry(undefined)]),
  )) as { messages: ContextEvent["messages"] };

  assert.deepEqual(result.messages, [messages[0], messages[2]]);
});

test("leaves messages untouched when there is no turn context entry", async () => {
  const messages: ContextEvent["messages"] = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "user", content: "second", timestamp: 2 },
  ];
  const handler = registerExtension(createTurnContextExtension()).get("context")!;
  const result = await handler({ type: "context", messages } as never, createContext([]));

  assert.equal(result, undefined);
});

function turnContextEntry(content: string | undefined): SessionEntry {
  return {
    type: "custom",
    customType: TURN_CONTEXT_CUSTOM_TYPE,
    data: { content },
    id: "entry",
    parentId: null,
    timestamp: "2026-10-14T09:30:42.123Z",
  } as unknown as SessionEntry;
}

function createContext(entries: readonly SessionEntry[]): ExtensionContext {
  return {
    sessionManager: {
      getBranch: () => entries,
    },
  } as unknown as ExtensionContext;
}

function registerExtension(extension: ReturnType<typeof createTurnContextExtension>) {
  type Handler = (event: never, context: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  extension(api);
  return handlers;
}
