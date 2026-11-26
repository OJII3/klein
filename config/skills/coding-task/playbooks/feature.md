# Playbook: Feature

Own the domain model, verification bar, and final diff; delegate bounded implementation units to fresh coding sessions.

## Steps

1. **Trace the affected subsystem**: Run a fresh read-only coding session (or inspect directly for small scopes) to map callers, types, persistence, and existing patterns.
2. **Name data shapes and boundaries**: Before writing logic, read `../principles/core.md` (**Foundational Thinking**) and `../principles/architecture.md` (**Model the Domain**, **Boundary & Type Discipline**). Define core types, state transitions, invariants, and what concurrent actors share.
3. **Compete on shape when uncertain**: When multiple valid designs exist or the boundary is costly to reverse, run `playbooks/arena.md` instead of committing to the first idea.
4. **Sequence verifiable units**:
   - Land shared scaffolds (types, interfaces, test harnesses) before features.
   - Because `pi` sessions share one repository working tree, **serialize** coding sessions that write to the repository; parallelize only read-only exploration or `/tmp` prototyping.
5. **Delegate implementation**: Start a fresh `coding_session_start` (`Read <skill-dir>/session-rules.md before anything else.`) per unit with the goal, branch rule, named data shapes, file scope, non-goals, relevant `principles/*.md` paths, and exact verification commands.
6. **Verify on the real surface**: Confirm observable behavior end-to-end (`../principles/verification.md` — Prove It Works) plus all repo checks (`format`, `lint`, `typecheck`, `tests`, `build`).
7. **Adversarial review**: Run `playbooks/interrogate.md` for non-trivial features or cross-boundary changes.
8. **Ship**: Run `playbooks/opening-a-pr.md`.
