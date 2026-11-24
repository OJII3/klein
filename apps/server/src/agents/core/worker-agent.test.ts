import assert from "node:assert/strict";
import test from "node:test";

import {
  renderWorkerSecretsSection,
  renderWorkerDelegationSection,
  renderWorkerT3ThreadSection,
} from "./worker-agent";

test("renders browser, T3, and shell capabilities when enabled", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: true,
    t3Available: true,
    t3ProjectAvailable: true,
    shell: "sandbox",
    secretsAvailable: true,
    watchAvailable: true,
  });

  assert.match(section, /worker_start/);
  assert.match(section, /agent-browser/);
  assert.match(section, /t3_thread_start/);
  assert.match(section, /sandboxed shell/);
  assert.match(section, /Missing CLI tools can be installed into the sandbox's `~\/\.local\/bin`/);
  assert.match(section, /secret_request/);
  assert.match(section, /Never ask the user to paste a password/);
  assert.match(section, /watch_add/);
  assert.match(section, /any repository on this machine/);
  assert.match(section, /Klein's own code, dotfiles, and machine settings/);
  assert.match(section, /t3_project_list/);
  assert.match(section, /can act on this machine through its shell or T3 Code/);
  assert.doesNotMatch(section, /not available in this conversation/);
});

test("tells the conversation agent to speak as the one who did the work", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: false,
    t3Available: false,
    t3ProjectAvailable: false,
    secretsAvailable: false,
    watchAvailable: false,
  });

  assert.match(section, /speak as the one who did the work/);
  assert.match(section, /never say you had, let, or made a worker do something/);
  assert.match(section, /「ワーカーに調べさせる」/);
});

test("notes disabled capabilities without claiming owner permissions", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: false,
    t3Available: false,
    t3ProjectAvailable: false,
    secretsAvailable: false,
    watchAvailable: false,
  });

  assert.match(section, /worker_start/);
  assert.match(section, /does not have/);
  assert.match(section, /or a shell or asking the linked user for secrets/);
  assert.match(section, /asking the linked user for secrets/);
  assert.doesNotMatch(section, /owner permissions/);
  assert.doesNotMatch(section, /t3_project_list/);
  assert.doesNotMatch(section, /can act on this machine through its shell or T3 Code/);
  assert.doesNotMatch(section, /watch_add/);
});

test("mentions only the capabilities that are unavailable", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: true,
    t3Available: false,
    t3ProjectAvailable: true,
    secretsAvailable: false,
    watchAvailable: false,
  });

  assert.match(section, /agent-browser/);
  assert.match(
    section,
    /does not have T3 Code thread creation and follow-ups via `t3_thread_start`/,
  );
  assert.match(
    section,
    /does not have T3 Code thread creation and follow-ups via `t3_thread_start` or a shell or asking the linked user for secrets/,
  );
  assert.match(section, /list T3 Code projects directly with `t3_project_list`/);
  assert.doesNotMatch(section, /does not have real browser use via `agent-browser`/);
  assert.doesNotMatch(section, /can act on this machine through its shell or T3 Code/);
});

test("describes the unsandboxed shell for owner workers", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: false,
    t3Available: true,
    t3ProjectAvailable: false,
    shell: "host",
    secretsAvailable: false,
    watchAvailable: false,
  });

  assert.match(section, /An unsandboxed shell/);
  assert.match(
    section,
    /run commands as Klein's user in the host home, with access to the host's repositories, dotfiles, installed CLIs, and machine settings/,
  );
  assert.match(section, /can act on this machine through its shell or T3 Code/);
});

test("renders worker guidance for routing repository work to T3 threads", () => {
  const section = renderWorkerT3ThreadSection();

  assert.match(section, /Repository work belongs in a T3 Code thread/);
  assert.match(section, /t3_thread_start/);
  assert.match(section, /t3_thread_send/);
  assert.match(section, /t3_thread_wait/);
  assert.match(section, /t3_thread_show/);
  assert.match(section, /t3_project_list/);
  assert.match(section, /PR creation/);
  assert.match(section, /not limited to Klein's own repository/);
  assert.match(section, /Klein's source code/);
  assert.match(section, /edit dotfiles and change machine settings/);
});

test("routes owner workers to their shell before T3 threads", () => {
  const section = renderWorkerT3ThreadSection("host");

  assert.match(section, /Repository work can run directly in your shell, in the host home/);
  assert.match(section, /t3_thread_send/);
  assert.doesNotMatch(section, /Repository work belongs in a T3 Code thread/);
});

test("renders secret guidance without promising values to the model", () => {
  const section = renderWorkerSecretsSection();

  assert.match(section, /secret_request/);
  assert.match(section, /secret_list/);
  assert.match(section, /secret_run/);
  assert.match(section, /secret_delete/);
  assert.match(section, /KLEIN_SECRET_/);
  assert.match(section, /redacts/);
  assert.match(section, /never enter this conversation/);
});
