import assert from "node:assert/strict";
import test from "node:test";

import { renderWorkerDelegationSection } from "./attached-agent";

test("renders owner-only browser and T3 capabilities when enabled", () => {
  const section = renderWorkerDelegationSection({
    ownerBrowserAvailable: true,
    ownerT3Available: true,
    watchAvailable: true,
  });

  assert.match(section, /worker_start/);
  assert.match(section, /agent-browser/);
  assert.match(section, /t3_thread_\*/);
  assert.match(section, /watch_add/);
});

test("notes that owner-only capabilities are disabled when not allowed", () => {
  const section = renderWorkerDelegationSection({
    ownerBrowserAvailable: false,
    ownerT3Available: false,
    watchAvailable: false,
  });

  assert.match(section, /worker_start/);
  assert.match(section, /NOT available in this conversation/);
  assert.doesNotMatch(section, /watch_add/);
});
