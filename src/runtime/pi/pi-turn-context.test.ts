import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager, type ContextEvent } from "@earendil-works/pi-coding-agent";

import {
  createStubExtensionContext,
  extractContextMessagesResult,
  loadTestExtension,
} from "./pi-test-helpers";
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
      blocks: [
        { name: "guild-memory", content: "guild context" },
        { name: "channel-rule", content: "channel rule" },
      ],
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
  const ext = await loadTestExtension(createTurnContextExtension());
  const handler = ext.handlers.get("context")?.[0];
  assert.ok(handler);
  const result = await handler({ type: "context", messages }, createContext("guild context"));
  const resultMessages = extractContextMessagesResult(result);

  assert.equal(resultMessages.length, 3);
  assert.deepEqual(resultMessages[0], messages[0]);
  assert.deepEqual(resultMessages[1], {
    role: "custom",
    customType: TURN_CONTEXT_CUSTOM_TYPE,
    content: "guild context",
    display: false,
    timestamp: resultMessages[1]?.timestamp,
  });
  assert.deepEqual(resultMessages[2], messages[1]);
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
  const ext = await loadTestExtension(createTurnContextExtension());
  const handler = ext.handlers.get("context")?.[0];
  assert.ok(handler);
  const result = await handler({ type: "context", messages }, createContext(undefined));
  const resultMessages = extractContextMessagesResult(result);

  assert.deepEqual(resultMessages, [messages[0], messages[2]]);
});

test("leaves messages untouched when there is no turn context entry", async () => {
  const messages: ContextEvent["messages"] = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "user", content: "second", timestamp: 2 },
  ];
  const ext = await loadTestExtension(createTurnContextExtension());
  const handler = ext.handlers.get("context")?.[0];
  assert.ok(handler);
  const result = await handler(
    { type: "context", messages },
    createStubExtensionContext({ sessionManager: SessionManager.inMemory() }),
  );

  assert.equal(result, undefined);
});

function createContext(content: string | undefined) {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendCustomEntry(TURN_CONTEXT_CUSTOM_TYPE, { content });
  return createStubExtensionContext({ sessionManager });
}
