# Playbook: Refactoring

Deliver cleaner structure with unchanged observable behavior and measurably lower reader load.

## Steps

1. **Name the structural problem**: Read `../principles/core.md` (**Minimize Reader Load**, **Subtract Before You Add**) and `../principles/verification.md` (**Test Behavior, Not Implementation**). Record which layers, hidden state, or duplicated decisions the refactor removes.
2. **Pin existing behavior first**: Ensure tests or an equivalence baseline cover the public behavior before reshaping internals. Do not rely on tests pinned to private helpers.
3. **Subtract then reshape**: Start a fresh `coding_session_start` (`Read <skill-dir>/session-rules.md before anything else.`) instructing it to sequence verifiable units: remove dead weight first, then apply the structural reshape, then clean up callers (`../principles/architecture.md` — Migrate Callers Then Delete Legacy APIs).
4. **Prove equivalence**: Run the pinned behavior suite and full repository checks against the real artifact (`../principles/verification.md` — Prove It Works).
5. **Confirm lower reader load**: Inspect the resulting `git diff`. If the refactor added indirection without reducing layers or hidden state, revert it (`../principles/core.md` — Laziness Protocol).
6. **Ship**: Run `playbooks/opening-a-pr.md`.
