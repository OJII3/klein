# Klein

## Overview

Klein is an LLM agent for Discord, built on Pi.

## Discord messages

The character is the point of this bot, so ordinary message content is reserved for lines the character speaks.

A message that is not the character speaking — access requests, interaction replies, status and error notices — sets `MessageFlags.IsComponentsV2` and builds its body from `ContainerBuilder` and `TextDisplayBuilder` instead of `content`. Components v2 renders such a message as a container rather than a plain text bubble, so it does not read as the character's voice.

## Rules

| Rule                                                                                                                                                                                                                                                                                | Enforced by                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A non-character Discord message uses `createTextContainerMessage` or `createEphemeralTextContainerMessage`. `reply` and `editReply` take `DiscordInteractionMessage`, never `content`.                                                                                              | `bun check` (interaction types) and `bun test` (`repository-conventions.test.ts`) |
| Web UI copy is English. Japanese belongs in the Discord character's reply.                                                                                                                                                                                                          | `bun test` (`repository-conventions.test.ts`)                                     |
| A new comment records a constraint the code cannot show and starts with `Why:`, `Security:`, `External:`, `Protocol:`, `Format:`, or `Config:`. Delete comments that restate code or tests. Existing comments are grandfathered in `apps/server/src/testing/comment-baseline.json`. | `bun test` (`repository-conventions.test.ts`)                                     |
| Domain does not import ports, application, or infrastructure; ports do not import application or infrastructure; application does not import infrastructure.                                                                                                                        | `bun lint` (`.oxlintrc.json` overrides)                                           |
| Imports do not form cycles.                                                                                                                                                                                                                                                         | `bun lint` (`import/no-cycle`)                                                    |
| Format, lint, and tests pass before a commit.                                                                                                                                                                                                                                       | CI (`.github/workflows/ci.yml`)                                                   |

## Before committing

Run the following commands and confirm they pass before committing.

- `bun fmt`
- `bun lint:fix`
- `bun test`
