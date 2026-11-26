import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { isRecord, parseJson } from "@shared/type-guards";

import type { SkillAudienceCapabilities } from "@runtime/pi/skill-availability";
import { createWebUiApp } from "./elysia-webui-app";
import { PiSkillReader } from "./pi-skill-reader";
import { createTempDir } from "../../../testing/temp-dir";

const CAPABILITIES: SkillAudienceCapabilities = {
  conversation: { browser: false, coding: false },
  ownerWorker: { browser: true, coding: true },
  linkedUserWorker: { browser: true, coding: false },
};

const SKILL_CONTENT = "---\nname: shared\ndescription: A shared skill.\n---\n\n# Shared\n";

function stubDependencies() {
  return {
    displayName: "Klein",
    pinoLogs: { list: async () => ({ items: [], nextCursor: null }) },
    piSessions: {
      list: async () => ({ items: [], nextCursor: null }),
      get: async () => undefined,
    },
    toolUsage: {
      read: async () => ({
        totalCalls: 0,
        totalErrors: 0,
        sessionCount: 0,
        tools: [],
        mcpServers: [],
      }),
    },
  };
}

test("serves the skills report and confined skill files", async () => {
  await using temp = await createTempDir("klein-skills-routes-");
  const skillsDirectory = join(temp.path, "skills");
  await mkdir(join(skillsDirectory, "shared"), { recursive: true });
  await writeFile(join(skillsDirectory, "shared", "SKILL.md"), SKILL_CONTENT, "utf8");
  await writeFile(join(skillsDirectory, "shared", "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(temp.path, "secret.md"), "secret", "utf8");

  const app = createWebUiApp({
    ...stubDependencies(),
    skills: new PiSkillReader({
      profile: "klein",
      skillsDirectories: [skillsDirectory],
      agentDirectory: join(temp.path, "pi"),
      capabilities: CAPABILITIES,
    }),
  });

  const report = await app.handle(new Request("http://localhost/api/skills"));
  assert.equal(report.status, 200);
  const reportBody = assertRecord(await readJson(report));
  assert.equal(reportBody.profile, "klein");
  assert.equal(reportBody.directory, skillsDirectory);
  assert.equal(reportBody.directoryExists, true);
  assert.equal(assertArray(reportBody.skills).length, 1);

  const file = await app.handle(
    new Request("http://localhost/api/skills/shared/file?path=SKILL.md"),
  );
  assert.equal(file.status, 200);
  assert.deepEqual(await readJson(file), { path: "SKILL.md", content: SKILL_CONTENT });

  const unknownSkill = await app.handle(
    new Request("http://localhost/api/skills/missing/file?path=SKILL.md"),
  );
  assert.equal(unknownSkill.status, 404);

  const missingFile = await app.handle(
    new Request("http://localhost/api/skills/shared/file?path=missing.md"),
  );
  assert.equal(missingFile.status, 404);

  const traversal = await app.handle(
    new Request(
      `http://localhost/api/skills/shared/file?path=${encodeURIComponent("../../secret.md")}`,
    ),
  );
  assert.equal(traversal.status, 400);

  const absoluteEscape = await app.handle(
    new Request(
      `http://localhost/api/skills/shared/file?path=${encodeURIComponent(join(temp.path, "secret.md"))}`,
    ),
  );
  assert.equal(absoluteEscape.status, 400);

  const binary = await app.handle(
    new Request("http://localhost/api/skills/shared/file?path=binary.bin"),
  );
  assert.equal(binary.status, 400);
});

test("returns an empty report when the skills reader is absent", async () => {
  const app = createWebUiApp(stubDependencies());

  const report = await app.handle(new Request("http://localhost/api/skills"));
  assert.equal(report.status, 200);
  assert.deepEqual(await readJson(report), {
    profile: "",
    directory: "",
    directoryExists: false,
    skills: [],
    diagnostics: [],
  });

  const file = await app.handle(
    new Request("http://localhost/api/skills/shared/file?path=SKILL.md"),
  );
  assert.equal(file.status, 404);
});

async function readJson(response: Response): Promise<unknown> {
  return parseJson(await response.text());
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) assert.fail("Expected JSON object");
  return value;
}

function assertArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) assert.fail("Expected JSON array");
  return value;
}
