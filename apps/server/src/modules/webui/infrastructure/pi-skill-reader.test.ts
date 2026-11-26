import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { SkillSummary } from "@klein/webui-api";

import type { SkillAudienceCapabilities } from "@runtime/pi/skill-availability";
import { PiSkillReader } from "./pi-skill-reader";
import { createTempDir } from "../../../testing/temp-dir";

const CAPABILITIES: SkillAudienceCapabilities = {
  conversation: { browser: false, coding: false },
  ownerWorker: { browser: true, coding: true },
  linkedUserWorker: { browser: true, coding: false },
};

const SHARED_SKILL = "---\nname: shared\ndescription: A shared skill.\n---\n\n# Shared\n";
const FLAT_SKILL = "---\nname: flat\ndescription: A flat skill.\n---\n\n# Flat\n";

async function withSkillsDirectory(
  run: (directory: string, reader: PiSkillReader) => Promise<void>,
): Promise<void> {
  await using temp = await createTempDir("klein-skills-");
  const directory = join(temp.path, "skills");

  await mkdir(join(directory, "shared", "references"), { recursive: true });
  await writeFile(join(directory, "shared", "SKILL.md"), SHARED_SKILL, "utf8");
  await writeFile(join(directory, "shared", "references", "notes.md"), "notes", "utf8");
  await writeFile(join(directory, "shared", "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(directory, "flat.md"), FLAT_SKILL, "utf8");

  await mkdir(join(directory, "browser-use"));
  await writeFile(
    join(directory, "browser-use", "SKILL.md"),
    "---\nname: browser-use\ndescription: Browse pages.\n---\n",
    "utf8",
  );

  await mkdir(join(directory, "coding-task"));
  await writeFile(
    join(directory, "coding-task", "SKILL.md"),
    "---\nname: coding-task\ndescription: Delegate repository work.\n---\n",
    "utf8",
  );

  await mkdir(join(directory, "manual"));
  await writeFile(
    join(directory, "manual", "SKILL.md"),
    "---\nname: manual\ndescription: Invoked by hand.\ndisable-model-invocation: true\n---\n",
    "utf8",
  );

  await mkdir(join(directory, "broken"));
  await writeFile(join(directory, "broken", "SKILL.md"), "---\nname: broken\n---\n", "utf8");

  await writeFile(join(temp.path, "secret.md"), "secret", "utf8");

  await run(
    temp.path,
    new PiSkillReader({
      profile: "test",
      skillsDirectories: [directory],
      agentDirectory: join(temp.path, "pi"),
      capabilities: CAPABILITIES,
    }),
  );
}

function skillNamed(skills: readonly SkillSummary[], name: string): SkillSummary {
  const skill = skills.find((candidate) => candidate.name === name);
  assert.ok(skill, `Expected skill ${name}`);
  return skill;
}

test("lists loaded skills with files, requirements, and availability", async () => {
  await withSkillsDirectory(async (directory, reader) => {
    const report = await reader.list();

    assert.equal(report.profile, "test");
    assert.equal(report.directory, join(directory, "skills"));
    assert.equal(report.directoryExists, true);
    assert.deepEqual(
      report.skills.map((skill) => skill.name),
      ["browser-use", "coding-task", "flat", "manual", "shared"],
    );

    const shared = skillNamed(report.skills, "shared");
    assert.equal(shared.description, "A shared skill.");
    assert.equal(shared.source, join(directory, "skills", "shared"));
    assert.deepEqual(
      shared.files.map((file) => file.path),
      ["SKILL.md", "binary.bin", "references/notes.md"],
    );
    assert.equal(shared.files[0]?.size, Buffer.byteLength(SHARED_SKILL));
    assert.equal(shared.modelInvocable, true);
    assert.deepEqual(shared.requirements, []);
    assert.deepEqual(shared.availability, {
      conversation: true,
      ownerWorker: true,
      linkedUserWorker: true,
    });

    assert.deepEqual(skillNamed(report.skills, "browser-use").requirements, ["browser"]);
    assert.deepEqual(skillNamed(report.skills, "browser-use").availability, {
      conversation: false,
      ownerWorker: true,
      linkedUserWorker: true,
    });
    assert.deepEqual(skillNamed(report.skills, "coding-task").requirements, ["coding"]);
    assert.deepEqual(skillNamed(report.skills, "coding-task").availability, {
      conversation: false,
      ownerWorker: true,
      linkedUserWorker: false,
    });

    const manual = skillNamed(report.skills, "manual");
    assert.equal(manual.modelInvocable, false);
    assert.equal(manual.promptEntry, null);

    const flat = skillNamed(report.skills, "flat");
    assert.match(flat.source, /flat\.md$/u);
    assert.deepEqual(
      flat.files.map((file) => file.path),
      ["flat.md"],
    );
    assert.deepEqual(flat.availability, {
      conversation: true,
      ownerWorker: true,
      linkedUserWorker: true,
    });
  });
});

test("builds the exact prompt entry Pi advertises", async () => {
  await withSkillsDirectory(async (_directory, reader) => {
    const report = await reader.list();
    const entry = skillNamed(report.skills, "shared").promptEntry;

    assert.ok(entry);
    assert.ok(entry.startsWith("<skill>"));
    assert.match(entry, /<name>shared<\/name>/u);
    assert.ok(entry.endsWith("</skill>"));
  });
});

test("reports skills Pi could not load", async () => {
  await withSkillsDirectory(async (_directory, reader) => {
    const report = await reader.list();

    assert.equal(report.diagnostics.length, 1);
    assert.equal(report.diagnostics[0]?.type, "warning");
    assert.match(report.diagnostics[0]?.message ?? "", /description is required/u);
    assert.ok(report.diagnostics[0]?.path?.endsWith("broken/SKILL.md"));
  });
});

test("reads files inside a skill directory", async () => {
  await withSkillsDirectory(async (directory, reader) => {
    assert.deepEqual(await reader.readFile("shared", "SKILL.md"), {
      path: "SKILL.md",
      content: SHARED_SKILL,
    });
    assert.deepEqual(await reader.readFile("shared", "references/notes.md"), {
      path: "references/notes.md",
      content: "notes",
    });
    assert.deepEqual(
      await reader.readFile(
        "shared",
        join(directory, "skills", "shared", "references", "notes.md"),
      ),
      { path: "references/notes.md", content: "notes" },
    );
    assert.deepEqual(await reader.readFile("flat", "flat.md"), {
      path: "flat.md",
      content: FLAT_SKILL,
    });
  });
});

test("returns undefined for unknown skills and missing files", async () => {
  await withSkillsDirectory(async (_directory, reader) => {
    assert.equal(await reader.readFile("missing-skill", "SKILL.md"), undefined);
    assert.equal(await reader.readFile("shared", "missing.md"), undefined);
  });
});

test("rejects paths outside the skill directory", async () => {
  await withSkillsDirectory(async (directory, reader) => {
    await assert.rejects(
      reader.readFile("shared", "../browser-use/SKILL.md"),
      /outside the skill directory/u,
    );
    await assert.rejects(
      reader.readFile("shared", join(directory, "secret.md")),
      /outside the skill directory/u,
    );
    await assert.rejects(
      reader.readFile("flat", "shared/SKILL.md"),
      /outside the skill directory/u,
    );
  });
});

test("rejects binary files", async () => {
  await withSkillsDirectory(async (_directory, reader) => {
    await assert.rejects(reader.readFile("shared", "binary.bin"), /not text/u);
  });
});

test("reports a missing skills directory without diagnostics", async () => {
  await using temp = await createTempDir("klein-skills-missing-");
  const reader = new PiSkillReader({
    profile: "test",
    skillsDirectories: [join(temp.path, "skills")],
    agentDirectory: join(temp.path, "pi"),
    capabilities: CAPABILITIES,
  });

  const report = await reader.list();
  assert.equal(report.directoryExists, false);
  assert.deepEqual(report.skills, []);
  assert.deepEqual(report.diagnostics, []);
});

test("lists skills across profile and shared directories including nested references", async () => {
  await using temp = await createTempDir("klein-skills-multi-");
  const profileDir = join(temp.path, "profile", "skills");
  const sharedDir = join(temp.path, "shared", "skills");
  await mkdir(join(profileDir, "voice"), { recursive: true });
  await mkdir(join(sharedDir, "coding-task", "playbooks"), { recursive: true });
  await mkdir(join(sharedDir, "coding-task", "principles"), { recursive: true });
  await writeFile(
    join(profileDir, "voice", "SKILL.md"),
    "---\nname: voice\ndescription: Profile voice skill.\n---\n",
    "utf8",
  );
  await writeFile(
    join(sharedDir, "coding-task", "SKILL.md"),
    "---\nname: coding-task\ndescription: Shared coding skill.\n---\n",
    "utf8",
  );
  await writeFile(join(sharedDir, "coding-task", "playbooks", "bug-fix.md"), "bug fix", "utf8");
  await writeFile(join(sharedDir, "coding-task", "principles", "core.md"), "core", "utf8");

  const reader = new PiSkillReader({
    profile: "test",
    skillsDirectories: [join(temp.path, "missing"), profileDir, sharedDir],
    agentDirectory: join(temp.path, "pi"),
    capabilities: CAPABILITIES,
  });

  const report = await reader.list();
  assert.equal(report.directoryExists, true);
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(
    report.skills.map((skill) => skill.name),
    ["coding-task", "voice"],
  );
  assert.equal(skillNamed(report.skills, "voice").source, join(profileDir, "voice"));
  const codingTask = skillNamed(report.skills, "coding-task");
  assert.equal(codingTask.source, join(sharedDir, "coding-task"));
  assert.deepEqual(
    codingTask.files.map((file) => file.path),
    ["SKILL.md", "playbooks/bug-fix.md", "principles/core.md"],
  );
  assert.deepEqual(await reader.readFile("coding-task", "playbooks/bug-fix.md"), {
    path: "playbooks/bug-fix.md",
    content: "bug fix",
  });
});
