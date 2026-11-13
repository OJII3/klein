# Klein

## Overview

Klein is an LLM agent for Discord, built on Pi.

## Discord messages

The character is the point of this bot, so ordinary message content is reserved for lines the character speaks.

A message that is not the character speaking — access requests, interaction replies, status and error notices — sets `MessageFlags.IsComponentsV2` and builds its body from `ContainerBuilder` and `TextDisplayBuilder` instead of `content`. Components v2 renders such a message as a container rather than a plain text bubble, so it does not read as the character's voice.

## Before committing

Run the following commands and confirm they pass before committing.

- `bun fmt`
- `bun lint:fix`
- `bun test`
