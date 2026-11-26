# Core Principles

## Laziness Protocol

- Trigger: refactoring, sizing a diff, or feeling tempted to add abstractions, helper layers, or pass-through flags.
- Consolidate repeated choices behind one source of truth instead of duplicating conditional logic across callers.
- Bias toward deletion and the smallest change that solves the problem; fewer clear lines beat speculative boilerplate.

## Foundational Thinking

- Trigger: before writing new logic, choosing core types/data structures, or sequencing scaffold vs. feature work.
- Name the core data shapes and trace every access pattern before writing implementation code.
- Before sharing state across concurrent sessions or async flows, ask what happens under concurrent writes; isolate before serializing.
- Land shared scaffolds (types, harnesses, test fixtures) before features built on top of them.

## Redesign from First Principles

- Trigger: integrating a new requirement into an existing design where patches feel bolted on.
- Ask: "If we built this from scratch with this requirement on day one, what shape would it have?"
- Propagate the clean shape across affected types, callers, and tests rather than piling compatibility workarounds on top.

## Attack the Premise

- Trigger: two or more fixes sharing the same assumption fail the same check or symptom.
- Stop writing another patch. Write down the shared assumption in one sentence and run an experiment or probe that would come out differently if that assumption were false.
- Only design the next fix once the underlying mechanism is directly observed.

## Subtract Before You Add

- Trigger: starting a feature, refactor, or rewrite in cluttered code.
- Delete dead code, redundant validators, stale flags, and single-use indirection first, then build on the simpler base.
- Do not leave stub files or empty compatibility shims behind.

## Minimize Reader Load

- Trigger: reviewing diffs or shaping code that feels hard to follow.
- Count how many hops a reader must trace between question and answer, and how much hidden state they must hold in memory.
- Collapse single-caller wrappers, shrink mutable scope, and keep control flow flat with early returns.
