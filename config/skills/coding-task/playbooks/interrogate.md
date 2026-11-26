# Playbook: Interrogate (Adversarial Review)

Run before shipping non-trivial changes, bug fixes touching shared state/concurrency, or contested designs. Adversaries run read-only against the repo and prove failures with runnable commands.

## Steps

1. **Launch 1–2 fresh read-only adversary sessions**:
   - For non-trivial diffs, run 2 adversaries in parallel (`wait: false` + `coding_session_wait` or `codemode` `Promise.allSettled`) with distinct lenses:
     - **Adversary 1 (Runtime & Edge Cases)**: concurrency, state transitions, error recovery, persistence, boundary inputs.
     - **Adversary 2 (Contracts & Regressions)**: caller assumptions, type safety, config/CLI paths, unhandled variants.
   - Give each adversary:
     - First line: `Read <skill-dir>/session-rules.md before anything else.`
     - The stated goal, target branch/diff summary, and an isolated scratch directory `/tmp/interrogate-<slug>/adv-<n>/` (forbid modifying any repository file).
     - Brief: _"Break this change. Prove every finding by running a real command, test, or repro script against the current tree. Report each finding with title, exact command, observed output, and expected output per the intent. Omit anything you did not run, style/naming opinions, and speculative future-only risks. 'No verified findings' is a valid result."_
2. **Verify every finding yourself**:
   - Re-run each reported command via `bash` (or verify its output directly). Keep only findings whose failure is reproduced and actually breaks the stated goal. Merge findings that share a root cause and drop unproven noise.
3. **Clean up and fix**:
   - Remove `/tmp/interrogate-<slug>/` and confirm `git status` is clean of scratch files.
   - If verified findings remain, start a fresh `coding_session_start` with the goal, branch, and verified repros to fix them at the root cause, then re-verify on the same commands.
