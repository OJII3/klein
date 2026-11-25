import assert from "node:assert/strict";
import test from "node:test";

import {
  excludedSkillNamesFor,
  resolveSkillAudienceCapabilities,
  skillRequirements,
} from "./skill-availability";

test("excludes a skill only while its required tool is unavailable", () => {
  assert.deepEqual([...excludedSkillNamesFor({ browser: false, coding: false })].toSorted(), [
    "browser-use",
    "coding-task",
    "self-improvement",
  ]);
  assert.deepEqual([...excludedSkillNamesFor({ browser: true, coding: false })].toSorted(), [
    "coding-task",
    "self-improvement",
  ]);
  assert.deepEqual([...excludedSkillNamesFor({ browser: false, coding: true })], ["browser-use"]);
  assert.deepEqual([...excludedSkillNamesFor({ browser: true, coding: true })], []);
});

test("maps each audience to the tools it receives by default", () => {
  assert.deepEqual(resolveSkillAudienceCapabilities(), {
    conversation: { browser: false, coding: false },
    ownerWorker: { browser: true, coding: true },
    linkedUserWorker: { browser: true, coding: false },
  });
});

test("keeps owner-worker tools unavailable when no owner is configured", () => {
  assert.deepEqual(resolveSkillAudienceCapabilities(undefined, false).ownerWorker, {
    browser: false,
    coding: false,
  });
});

test("honors explicit tool and server denials", () => {
  const capabilities = resolveSkillAudienceCapabilities({
    mcp: { servers: { agent_browser: "deny" } },
    tools: { overrides: { coding_task_start: "deny" } },
  });

  assert.deepEqual(capabilities.ownerWorker, { browser: false, coding: false });
  assert.deepEqual(capabilities.linkedUserWorker, { browser: false, coding: false });
});

test("keeps the built-in browser server available to linked users by default", () => {
  const capabilities = resolveSkillAudienceCapabilities({ mcp: { default: "owner" } });

  assert.equal(capabilities.linkedUserWorker.browser, true);
});

test("lists the requirement for a known skill and none for a shared skill", () => {
  assert.deepEqual(skillRequirements("browser-use"), ["browser"]);
  assert.deepEqual(skillRequirements("coding-task"), ["coding"]);
  assert.deepEqual(skillRequirements("self-improvement"), ["coding"]);
  assert.deepEqual(skillRequirements("shared"), []);
});
