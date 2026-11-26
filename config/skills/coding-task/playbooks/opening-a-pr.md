# Playbook: Opening a PR

Run at the end of every code-changing playbook before reporting completion.

## Steps

1. **Inspect the diff yourself**: Run `git status` and `git diff` (via `bash` or a fresh read-only review session). Remove dead code, unused imports/helpers, AI slop, unjustified comments, and any stray `.md` docs.
2. **Verify all checks at HEAD**: Run the repository's own verification suite (`bun fmt --check`, `bun run lint`, `bun run typecheck`, `bun test`, `bun run build`, or the target repo's equivalents) and observe passing results. Never rely on earlier runs before final edits.
3. **Check branch and commits**: Ensure changes are on a dedicated feature branch (never committed directly to `main` unless explicitly requested) with small, clean, verifiable commits.
4. **Push and open a ready PR**:
   - Push the branch and create a ready-for-review PR (`gh pr create` without `--draft`).
   - Title: `type(scope): subject` naming the key symbol or area when helpful.
   - Body (under 40 lines, omitting empty headings, in this exact order):
     - `## Why` (open with the user's goal)
     - `## What changed`
     - `## Scope`
     - `## Tradeoffs` (only rejected alternatives a reviewer would ask about)
     - `## Blast Radius`
     - `## Verification` (exact commands and observed outcomes)
   - Put long logs, command outputs, or large tables in a PR comment rather than bloating the PR body.
