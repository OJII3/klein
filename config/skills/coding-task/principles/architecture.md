# Architecture Principles

## Model the Domain

- Trigger: writing stateful workflows, multi-branch conditionals, or code that repeats structural assumptions across files.
- Encode state transitions and invariants in an explicit structure (state machine, discriminated union, lookup table, or registry) rather than scattered booleans and `if/else` chains.

## Boundary & Type Discipline

- Trigger: designing types, function signatures, validation, or adapters to external systems.
- Parse and validate untrusted inputs once at the system boundary; trust typed internal invariants downstream instead of repeating defensive checks inside core logic.
- Make illegal states unrepresentable with branded/narrow types and exhaustive switching.

## Make Operations Idempotent

- Trigger: designing persistence, startup/resume flows, cleanup loops, or PR/Git commands that may retry or crash mid-run.
- Ensure repeated runs converge safely to the same end state without duplicating side effects or corrupting stored state.

## Migrate Callers Then Delete Legacy APIs

- Trigger: introducing a cleaner internal API or renaming a concept while old callers still exist.
- Update all callers in the same wave and delete the legacy API instead of maintaining parallel compatibility wrappers.
