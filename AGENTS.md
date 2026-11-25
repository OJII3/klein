# Klein

## Overview

Klein is an LLM agent for Discord, built on Pi.

## Discord messages

The character is the point of this bot, so ordinary message content is reserved for lines the character speaks.

A message that is not the character speaking — access requests, interaction replies, status and error notices — sets `MessageFlags.IsComponentsV2` and builds its body from `ContainerBuilder` and `TextDisplayBuilder` instead of `content`. Components v2 renders such a message as a container rather than a plain text bubble, so it does not read as the character's voice.

## LLM UX

Every LLM-facing surface — system prompts (`SOUL.md`, `PROACTIVITY.md`, worker/curator/planner prompts), events, memory and turn context, tool definitions, `toolResult`s/errors, skill `description`s, and skill bodies — must be designed for the reading agent's goal, token budget, and ordering.

- Write operational rules, tool definitions, `toolResult`s, error messages, event metadata, and skill `description`s/workflows in **English** (models reason more reliably in English); reserve **Japanese** for character dialogue, tone, and Japanese output examples.
- Expose only concepts, tools, and instructions that belong to that agent's role and permissions; never introduce abrupt topics or internal terms the agent has no way to know.
- Keep always-loaded context lean, preserve prefix-cache ordering, and use intuitive, self-explanatory names.

Read `.agents/skills/llm-ux/SKILL.md` before adding, editing, or reviewing any LLM-facing surface.

## Rules

| Rule                                                                                                                                                                                                                                                                                | Enforced by                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A non-character Discord message uses `createTextContainerMessage` or `createEphemeralTextContainerMessage`. `reply` and `editReply` take `DiscordInteractionMessage`, never `content`.                                                                                              | `bun run typecheck` (interaction types) and `bun test` (`repository-conventions.test.ts`) |
| Web UI copy is English. Japanese belongs in the Discord character's reply.                                                                                                                                                                                                          | `bun test` (`repository-conventions.test.ts`)                                             |
| Any change to LLM-facing surfaces (prompts, events, memory, tools, `toolResult`s/errors, skills) follows `.agents/skills/llm-ux/SKILL.md`.                                                                                                                                          | Review & `self-improvement` / `investigate-feedback` workflows                            |
| A new comment records a constraint the code cannot show and starts with `Why:`, `Security:`, `External:`, `Protocol:`, `Format:`, or `Config:`. Delete comments that restate code or tests. Existing comments are grandfathered in `apps/server/src/testing/comment-baseline.json`. | `bun test` (`repository-conventions.test.ts`)                                             |
| Domain does not import ports, application, or infrastructure; ports do not import application or infrastructure; application does not import infrastructure.                                                                                                                        | `bun lint` (`.oxlintrc.json` overrides)                                                   |
| Imports do not form cycles.                                                                                                                                                                                                                                                         | `bun lint` (`import/no-cycle`)                                                            |
| Format, lint, and tests pass before a commit.                                                                                                                                                                                                                                       | CI (`.github/workflows/ci.yml`)                                                           |
| Do not add design docs, specs, plans, or notes as `.md` files inside the repository (outside `config/`, `.agents/`, `docs/*-protocol.md`, `README.md`, and `AGENTS.md`). Enforce constraints with types, lint rules, and tests instead.                                             | `bun test` (`repository-conventions.test.ts`)                                             |

## Before committing

Run the following commands and confirm they pass before committing.

- `bun fmt`
- `bun lint:fix`
- `bun test`
