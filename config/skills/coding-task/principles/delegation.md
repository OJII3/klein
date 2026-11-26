# Delegation Principles

## Guard the Context Window

- Trigger: large diffs, long logs, multi-file exploration, or comparing design candidates.
- Keep raw exploration, test logs, and competing prototypes inside coding sessions or `/tmp` artifacts; keep your worker context lean with structured summaries, exact file paths, and command results.

## Never Block on the Human

- Trigger: feeling tempted to pause and ask "should I do X?" during execution.
- Make reversible engineering choices yourself, proceed, and document what you chose and why in your report.
- Reserve pausing for irreversible actions (force-push to shared branches, deploys, data deletion, external messages), genuine product/UX ambiguity, or a confirmed dead end.

## Encode Lessons in Structure

- Trigger: catching yourself repeating the same review correction or operational warning across sessions.
- Encode the constraint in types, lint rules, `repository-conventions.test.ts`, or automated checks instead of adding another paragraph of prompt prose.
- Reserve prompt text only for rules that genuinely require judgment and cannot be checked statically.
