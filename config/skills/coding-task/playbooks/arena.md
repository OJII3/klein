# Playbook: Arena (Competing Designs)

Use when multiple valid designs exist or jumping straight to one implementation would lock in the wrong abstraction. All candidates run read-only against the repository and write prototypes/sketches only to `/tmp` so they can execute in parallel safely on `pi`.

## Steps

1. **Frame**:
   - Define the exact target artifact (module interfaces, data shapes, error model, or prototype scope).
   - Write 3–6 concrete, gradeable rubric criteria for success on _this_ task. Keep the rubric for yourself and the judge — do not show it to candidates.
2. **Fan out (parallel, read-only)**:
   - Start 2–3 fresh `coding_session_start` runs with `wait: false`, each given:
     - First line: `Read <skill-dir>/session-rules.md before anything else.`
     - Strict read-only rule: do **not** modify any files in the repository; write all design notes, types/signatures, prototype code, and rationale of rejected alternatives under `/tmp/arena-<slug>/candidate-<n>/`.
     - A distinct design angle (e.g., Candidate 1: minimal surgical extension; Candidate 2: domain-modeled boundary; Candidate 3: first-principles redesign).
   - Wait for all candidates using `coding_session_wait` or `codemode` `Promise.allSettled`. If one drops out, proceed with the survivors and note the dropout.
3. **Cross-judge (fresh read-only session)**:
   - Start one fresh read-only `coding_session_start` with the rubric and paths `/tmp/arena-<slug>/candidate-1..N/` (labeled only by number). Instruct it to score each candidate criterion-by-criterion, recommend a base, and list worth-grafting elements.
4. **Pick, graft, and implement**:
   - Read every candidate artifact and the judge's scoring yourself. Pick the cleanest base (prefer simpler boundaries and lower reader load on ties), list any stronger parts from losing candidates to graft, clean up `/tmp/arena-<slug>/`, and delegate final implementation to a fresh coding session under `playbooks/feature.md`.
