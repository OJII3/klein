# Agent input events

`AgentRuntime.prompt` and `steer` accept `AgentEvent` inputs defined in
`src/agents/core/agent-event.ts`. Each producer provides an internal tracing `id`,
an ISO 8601 `occurredAt` with a timezone, an event `type` (such as `discord.message`),
a `source`, and `content` containing text and image blocks:

```ts
await runtime.prompt({
  id: "reminder-123",
  occurredAt: "2026-10-14T18:30:42+09:00",
  type: "reminder.due",
  source: "reminder",
  content: [{ type: "text", text: "定例会の時間です。" }],
});
```

Text blocks use `{ type: "text", text }`; image blocks use
`{ type: "image", data, mimeType }`, where `data` is Base64. Source-specific data
stays in its producer; information relevant to the agent belongs in text blocks.

Pi receives the event type, source, and occurrence time in Japan Standard Time at
minute precision (for example, `2026-10-14 18:30 JST`), followed by the text and
images. The event ID and full timestamp stay internal. Discord preserves its original
posting time, author and reply text, conversation guidance, memory, and channel rules.
Voice transcripts use their receipt time.

New producers can use the same runtime interface for reminders, watches, MCP
notifications, and messages from other agents. Discord Pi sessions provide deferred
`reminder_add`, `reminder_list`, `reminder_delete`, `watch_add`, `watch_list`, and
`watch_delete` tools. Reminders can run once after a duration (minimum one minute),
once at the next occurrence of a time or at a specific date and time, or repeatedly
every N minutes, every day, or on selected weekdays in JST. Watches run a script on a
recurring schedule and emit `watch.triggered` only when the output changes. Scheduled
items are delivered to the session that created them; overdue repeating items fire once
after a restart and then resume their schedule. MCP notification subscriptions are not
implemented yet.

Tool permissions are fixed when the agent is created and apply to every event it
processes, including reminders, watches, and MCP notifications. `prompt(event)` and
`steer(event)` need no per-input permission options. Owner-only tools require an
owner-enabled session established by trusted application access checks; event content
cannot grant owner access.
