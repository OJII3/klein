# Verification Principles

## Prove It Works

- Trigger: after any task, before reporting completion or opening a PR.
- Verify directly against the real artifact: run the actual test suite, CLI, server path, or inspect the actual `git diff` and file contents.
- Proxies ("typecheck passed", "it compiles", file timestamps, or a coding session's self-report) are never proof. When an observation fails, inspect the measurement method first before assuming the system is wrong.

## Fix Root Causes

- Trigger: debugging failures, flaky behavior, or unexpected state.
- Trace the symptom backward to the first point where the system violated an invariant and fix it there.
- Adding a null guard, retry, or fallback is only a real fix if the state it handles is genuinely valid by specification.
- Fix the pattern everywhere it occurs, not just the single reported call site.

## Sequence Verifiable Units

- Trigger: multi-step changes, migrations, bug fixes, or structuring commits.
- Break work into small units that each end in a runnable check; verify unit N before starting unit N+1.
- Order git history so reviewers can follow the proof: failing repro test before fix, subtraction before reshape, baseline before optimization.

## Test Behavior, Not Implementation

- Trigger: writing, updating, or auditing tests.
- Assert observable inputs, outputs, errors, and external effects through public boundaries — never private helper call counts or internal wiring.
- Check each test mentally against two edits: breaking real behavior must fail the test; refactoring internals while preserving behavior must keep it green.
