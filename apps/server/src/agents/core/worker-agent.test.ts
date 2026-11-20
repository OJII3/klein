import assert from "node:assert/strict";
import test from "node:test";

import { renderWorkerDelegationSection } from "./worker-agent";

test("renders browser, T3, and shell capabilities when enabled", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: true,
    t3Available: true,
    shellAvailable: true,
    watchAvailable: true,
  });

  assert.match(section, /worker_start/);
  assert.match(section, /agent-browser/);
  assert.match(section, /t3_thread_\*/);
  assert.match(section, /sandboxed shell/);
  assert.match(section, /watch_add/);
  assert.doesNotMatch(section, /not available in this conversation/);
});

test("notes disabled capabilities without claiming owner permissions", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: false,
    t3Available: false,
    shellAvailable: false,
    watchAvailable: false,
  });

  assert.match(section, /worker_start/);
  assert.match(section, /does not have/);
  assert.match(section, /sandboxed shell/);
  assert.doesNotMatch(section, /owner permissions/);
  assert.doesNotMatch(section, /watch_add/);
});

test("mentions only the capabilities that are unavailable", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: true,
    t3Available: false,
    shellAvailable: false,
    watchAvailable: false,
  });

  assert.match(section, /agent-browser/);
  assert.match(section, /does not have T3 Code threads via `t3_thread_\*`/);
  assert.match(section, /does not have T3 Code threads via `t3_thread_\*` or a sandboxed shell/);
  assert.doesNotMatch(section, /does not have real browser use via `agent-browser`/);
});
