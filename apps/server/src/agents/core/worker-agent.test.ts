import assert from "node:assert/strict";
import test from "node:test";

import { renderWorkerDelegationSection, renderWorkerT3ThreadSection } from "./worker-agent";

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
  assert.match(section, /any repository on this machine/);
  assert.match(section, /Klein's own code, dotfiles, and machine settings/);
  assert.match(section, /can act on this machine through T3 Code/);
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
  assert.doesNotMatch(section, /can act on this machine through T3 Code/);
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

test("renders worker guidance for routing repository work to T3 threads", () => {
  const section = renderWorkerT3ThreadSection();

  assert.match(section, /t3_thread_start/);
  assert.match(section, /t3_thread_send/);
  assert.match(section, /t3_thread_show/);
  assert.match(section, /PR creation/);
  assert.match(section, /not limited to Klein's own repository/);
  assert.match(section, /Klein's source code/);
  assert.match(section, /edit dotfiles and change machine settings/);
});
