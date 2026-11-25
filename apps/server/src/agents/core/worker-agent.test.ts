import assert from "node:assert/strict";
import test from "node:test";

import { renderWorkerSecretsSection, renderWorkerDelegationSection } from "./worker-agent";

test("renders browser, coding, and shell capabilities when enabled", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: true,
    codingAvailable: true,
    codingProjectAvailable: true,
    shell: "sandbox",
    secretsAvailable: true,
    watchAvailable: true,
  });

  assert.match(section, /worker_start/);
  assert.match(section, /agent-browser/);
  assert.match(section, /coding_task_start/);
  assert.match(section, /sandboxed shell/);
  assert.match(section, /Missing CLI tools can be installed into the sandbox's `~\/\.local\/bin`/);
  assert.match(section, /secret_request/);
  assert.match(section, /Never ask the user to paste a password/);
  assert.match(section, /watch_add/);
  assert.match(section, /any repository on this machine/);
  assert.match(section, /Klein's own code, dotfiles, and machine settings/);
  assert.match(section, /coding_project_list/);
  assert.match(section, /do not call it just to prepare a handoff/);
  assert.match(section, /Hand off roughly in a short line/);
  assert.match(section, /no limit on the number of workers/i);
  assert.match(section, /improving Klein itself/);
  assert.match(section, /stay silent if it only reports background bookkeeping/);
  assert.match(section, /can act on this machine through its shell or a coding backend/);
  assert.doesNotMatch(section, /not available in this conversation/);
});

test("tells the conversation agent to speak as the one who did the work", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: false,
    codingAvailable: false,
    codingProjectAvailable: false,
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
    codingAvailable: false,
    codingProjectAvailable: false,
    secretsAvailable: false,
    watchAvailable: false,
  });

  assert.match(section, /worker_start/);
  assert.match(section, /does not have/);
  assert.match(section, /or a shell or asking the linked user for secrets/);
  assert.match(section, /asking the linked user for secrets/);
  assert.doesNotMatch(section, /owner permissions/);
  assert.doesNotMatch(section, /coding_project_list/);
  assert.doesNotMatch(section, /can act on this machine through its shell or a coding backend/);
  assert.doesNotMatch(section, /watch_add/);
});

test("mentions only the capabilities that are unavailable", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: true,
    codingAvailable: false,
    codingProjectAvailable: true,
    secretsAvailable: false,
    watchAvailable: false,
  });

  assert.match(section, /agent-browser/);
  assert.match(section, /does not have coding task delegation via `coding_task_start`/);
  assert.match(
    section,
    /does not have coding task delegation via `coding_task_start` or a shell or asking the linked user for secrets/,
  );
  assert.match(section, /list coding projects directly with `coding_project_list`/);
  assert.doesNotMatch(section, /does not have real browser use via `agent-browser`/);
  assert.doesNotMatch(section, /can act on this machine through its shell or a coding backend/);
});

test("describes the unsandboxed shell for owner workers", () => {
  const section = renderWorkerDelegationSection({
    browserAvailable: false,
    codingAvailable: true,
    codingProjectAvailable: false,
    shell: "host",
    secretsAvailable: false,
    watchAvailable: false,
  });

  assert.match(section, /An unsandboxed shell/);
  assert.match(
    section,
    /run commands as Klein's user in the host home, with access to the host's repositories, dotfiles, installed CLIs, and machine settings/,
  );
  assert.match(section, /can act on this machine through its shell or a coding backend/);
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
