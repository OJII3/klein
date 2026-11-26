# Playbook: Bug Fix

Be scientific. Every shipped line must trace to runtime evidence. Speculative guards or belt-and-suspenders patches do not ship.

## Steps

1. **Reproduce on the matching surface**: Run the failing command, test, or workflow directly (via `bash` or a read-only coding session) before changing code. Capture the exact failure output.
2. **Binary-search the root cause**: Trace the failing path and check `git log` / `git blame` for recent changes. Eliminate hypotheses with concrete observations until the first point of failure is confirmed (`../principles/verification.md` — Fix Root Causes).
   - If two or more fixes sharing one assumption fail the same check, read `../principles/core.md` (**Attack the Premise**) and test that assumption directly before writing another patch.
3. **Plan the minimal fix**: Name the root cause, the smallest change that fixes the pattern everywhere it occurs, and any affected data shapes or boundaries. If multiple valid designs exist, run `playbooks/arena.md`.
4. **Implement failing-test-first**: Start a fresh `coding_session_start` (`Read <skill-dir>/session-rules.md before anything else.`) with the goal, branch rule, root cause, exact file scope, and checks. Require a failing regression test (or repro check) before the fix (`../principles/verification.md` — Sequence Verifiable Units).
5. **Verify on the real surface**: Confirm the original repro fails before and passes after on the same surface (`../principles/verification.md` — Prove It Works), and run all repository checks.
6. **Adversarial check**: If the fix touches shared state, concurrency, persistence, or non-trivial boundaries, run `playbooks/interrogate.md`.
7. **Ship**: Run `playbooks/opening-a-pr.md`.
