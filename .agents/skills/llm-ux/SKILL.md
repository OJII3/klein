---
name: llm-ux
description: Design and review LLM-facing surfaces in Klein — system prompts (SOUL.md, PROACTIVITY.md, worker/curator/planner prompts), events, memory and turn context, tool definitions, tool results and errors, and skill descriptions/bodies. Use when creating, editing, or auditing any text an agent reads, or when investigating bad replies or awkward agent behavior.
---

# LLM UX in Klein

Every prompt, event, memory block, tool schema, tool result, error message, and skill is a user interface for the specific LLM session that reads it. Evaluate every LLM-facing change from the reading agent's point of view: **quantity, order, and wording must fit that agent's goal and current knowledge.**

## 1. Identify the Reading Agent and Its Goal

Before writing or reviewing any surface, confirm which agent reads it and what that agent is supposed to do:

| Agent                              | Main sources                                                                                                                                   | Primary goal                                                                                                                             | Must NOT be burdened with                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Conversation (text / voice)**    | `config/*/SOUL.md`, `SOUL.voice.md`, `config/PROACTIVITY.md`, Discord tools, turn context                                                      | Stay in character, decide whether to speak (`discord_send` / `discord_speak`) or stay silent, and delegate heavy work via `worker_start` | Multi-step research recipes, backend/coding workflows, tools only workers have                                |
| **Worker**                         | `WORKER_SYSTEM_PROMPT`, `config/*/skills/*`, `worker_start` handoff, inherited history                                                         | Investigate, plan, and execute in its own session; return concise findings to the conversation agent                                     | Addressing the Discord user directly, `discord_send` instructions, capabilities disabled for its access scope |
| **Background curators & planners** | `USER_MEMORY_AGENT_SYSTEM_PROMPT`, `SHARED_MEMORY_AGENT_SYSTEM_PROMPT`, `INITIATIVE_PLANNER_SYSTEM_PROMPT`, handoff/compaction, image analyzer | Single-purpose extraction, summary, or planning within strict schema and untrusted-data boundaries                                       | Unrelated conversation rules or character roleplay                                                            |
| **Coding agent**                   | `AGENTS.md`, `.agents/skills/*`, `pi-coding-backend` (`projectContext: true`, `noSkills: true`)                                                | Implement, verify, and ship repository changes                                                                                           | Runtime bot persona or Discord reply formatting                                                               |

## 2. Cross-Cutting Criteria

### Language: English for Reasoning, Japanese for Character Expression

- Most models think in English. Write operational instructions, behavioral constraints, role boundaries, tool `description`s, parameter schemas, `toolResult`s, error messages, `<event-metadata>`, memory schemas, and skill `description`s / workflows in **English**.
- Reserve **Japanese** for what directly shapes the character's final Japanese utterance: character voice/tone rules, Japanese phrasing nuances, and few-shot dialogue examples (e.g., `SOUL.md`, `honkai-character-dialogue`).
- Never leave stray Japanese operational error messages or internal instructions inside English tools or runtime code (e.g., thrown `Error` messages returned to the model as `toolResult`).

### Volume and Attention Budget

- Always-loaded surfaces (`SOUL.md`, `PROACTIVITY.md`, `WORKER_SYSTEM_PROMPT`, dynamic prompt sections, `exposure: "direct"` tool schemas, skill `description`s, per-turn `klein-turn-context`) consume tokens on every turn and dilute attention. Keep them short and non-redundant.
- Put detailed multi-step workflows and large example sets into `SKILL.md` or `references/*.md` loaded on demand, and mark specialized tools `exposure: "deferred"` (loaded via `tool_search`).
- Avoid repeating the same rule across `SOUL.md`, dynamic sections, tool descriptions, and skills unless intentional reinforcement is needed without contradiction.

### Order and Prefix-Cache Stability

- Keep static instructions (system prompt, tool declarations, skill catalog) stable across turns so provider prefix caching holds.
- Inject dynamic per-turn state (`klein-turn-context`: `<user-memory>`, `<shared-memory>`, `<channel-rule>`, `<proactive-preferences>`, `<waiting-on>`, `<pending-signals>`) right before the latest user/event message, never into the system prompt.
- Place decisive constraints (silent vs. reply, surface-tool requirement, untrusted-data boundary, output rules) where they are unmistakable and not contradicted by later examples.
- Keep multi-speaker, multi-turn, and synthetic message ordering clear (`<event-metadata>`, `<previous-conversation-context>`, `normalizeCompletedAssistantText`) so the model never confuses who spoke, who is addressed, or whether a past turn already sent a reply.

### Audience Isolation and No Abrupt Unknown Context

- Never mention tools, IDs, files, or concepts an agent cannot use or has no way to know about:
  - Do not teach a conversation agent `coding_session_start` or `agent-browser` internals; teach it when to delegate via `worker_start`.
  - Gate dynamic sections and skills strictly by role and capability (as in `renderWorkerDelegationSection` and `resolveSkillAudienceCapabilities`), so public or linked-user sessions never see owner-only capabilities.
  - Do not leak internal subsystem jargon or worker/tool terminology into surfaces meant for character speech.
- When an asynchronous or synthetic input arrives (`worker.result`, reminder/watch wake, interruption notice, inherited history), give just enough self-contained framing for the agent to understand _why_ this arrived and _what_ to do next.

### Intuitive Naming and Unambiguous Wording

- Choose self-explanatory, consistent names for tools, parameters, XML blocks, custom message types, and skills (`worker_start` vs. `coding_session_start`, `<user-memory>` vs. `<shared-memory>`, `<pending-signals>`). If a name requires a paragraph to explain what it is not, rename it.
- Tool `description`s must state **when to use**, **when not to use**, and **what happens next** (e.g., returns immediately and delivers a later event vs. waits for completion).
- `toolResult`s and thrown `Error`s must tell the model **what happened** and **what concrete next action to take**, not opaque error codes or stack-level details.
- Explicitly mark external inputs (Discord messages, web pages, images, GitHub issues/PRs/logs) as untrusted data, never instructions.

## 3. Surface-by-Surface Checklist

- **System prompts (`SOUL.md`, `SOUL.voice.md`, `PROACTIVITY.md`, `WORKER_SYSTEM_PROMPT`, dynamic sections)**:
  - Does every rule fit this agent's role and permissions?
  - Are few-shot examples consistent with every rule (e.g., no `。` in `discord_send` text examples, and unverified factual claims annotated so the model does not learn to hallucinate)?
  - Are operational mechanics in English while keeping character expression in Japanese?
- **Events & turn inputs (`pi-event-prompt.ts`, `discord-message-agent-turn.ts`, wakes/interruptions)**:
  - Are timestamp, source, sender, and channel/target unmistakable?
  - Would a cold turn reading only the transcript + this event immediately understand what happened?
- **Memory & turn context (`pi-turn-context.ts`, `pi-user-memory-agent.ts`, `pi-shared-memory-agent.ts`)**:
  - Are `<user-memory>` and `<shared-memory>` concise, deduplicated, and clearly separated by scope?
  - Do memory entries read as neutral facts/preferences rather than accidental imperatives?
- **Tool definitions & `toolResult` / errors (`apps/server/src/agents/**/tools/*.ts`)**:
  - Are names and parameters intuitive, minimal, and free of ambiguous overlaps?
  - Is `exposure` (`direct` vs. `deferred`) right for how often the agent needs the tool?
  - Are descriptions, tool outputs, and error messages written in English with clear recovery instructions?
- **Skills (`config/*/skills/*/SKILL.md`)**:
  - `description`: Short, trigger-focused, in English (unless character-dialogue-specific), accurately signaling when to load `SKILL.md` without bloating every turn.
  - `SKILL.md` body: Matches the audience allowed by `skill-availability.ts`, keeps heavy examples in `references/`, and avoids conflicting with `SOUL.md` or tool definitions.

## 4. Verify Against Rendered Context

Do not judge prompts only from isolated source files. Inspect the assembled request, token distribution, and prefix cache behavior with `inspect:context`:

```bash
bun run inspect:context show --case <caseId> --no-tools
bun run inspect:context show --session <sessionId-or-path> --turn -1
bun run inspect:context show --session <sessionId-or-path> --all-turns --max-turns 5 --no-tools
```
