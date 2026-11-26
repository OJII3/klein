# Playbook: Investigation

Use for read-only code tracing, debugging questions, architecture understanding, or decision tradeoffs. Produces a cited explanation or recommendation, never code edits or a PR.

## Steps

1. **Frame the question**: Restate what needs to be explained or decided and check if the premise of the question holds.
2. **Trace read-only**: Start a fresh read-only coding session (`Read <skill-dir>/session-rules.md before anything else.`) instructing it to read the relevant subsystem and inspect `git log` / `git blame` for design motivation or regression history without editing repository files. For wide multi-area traces, fan out 2–3 read-only sessions in parallel with `wait: false` and `coding_session_wait` or `codemode` `Promise.allSettled`.
3. **Synthesize and verify**: Check cited file paths, symbols, and behavior directly when a claim is surprising or central to a decision. Push back explicitly if the evidence contradicts the starting premise.
4. **Report**:
   - For explanations: **Overview / How It Works / Where Things Live / Gotchas**, citing exact file paths and symbol names.
   - For decisions: a concise **Options & Tradeoffs** comparison with a clear recommendation and why.
   - Label unverified inferences explicitly as inferred.
