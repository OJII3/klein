import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStubExtensionToolContext } from "./pi-test-helpers";
import { createSkillReadTool } from "./skill-read-tool";
import { createTempDir } from "../../testing/temp-dir";

async function withSkillsDirectory(
  run: (directory: string, tool: ReturnType<typeof createSkillReadTool>) => Promise<void>,
): Promise<void> {
  await using temp = await createTempDir("klein-skill-read-");
  const directory = temp.path;
  await mkdir(join(directory, "demo", "references"), { recursive: true });
  await writeFile(join(directory, "demo", "SKILL.md"), "line 1\nline 2\nline 3", "utf8");
  await writeFile(join(directory, "demo", "references", "notes.md"), "notes", "utf8");
  await run(directory, createSkillReadTool(directory));
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

test("reads a skill file by absolute or relative path", async () => {
  await withSkillsDirectory(async (directory, tool) => {
    const ctx = createStubExtensionToolContext();
    const absolute = await tool.execute(
      "call",
      { path: join(directory, "demo", "SKILL.md") },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(textOf(absolute), "line 1\nline 2\nline 3");

    const relative = await tool.execute(
      "call",
      { path: "demo/references/notes.md" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(textOf(relative), "notes");
  });
});

test("supports offset and limit", async () => {
  await withSkillsDirectory(async (directory, tool) => {
    const result = await tool.execute(
      "call",
      { path: join(directory, "demo", "SKILL.md"), offset: 2, limit: 1 },
      undefined,
      undefined,
      createStubExtensionToolContext(),
    );
    assert.equal(textOf(result), "line 2");
  });
});

test("rejects files outside the skills directory", async () => {
  await using temp = await createTempDir("klein-skill-outside-");
  const outsideDirectory = temp.path;
  const outsideFile = join(outsideDirectory, "outside.md");
  await writeFile(outsideFile, "outside", "utf8");
  await withSkillsDirectory(async (_directory, tool) => {
    await assert.rejects(
      tool.execute(
        "call",
        { path: outsideFile },
        undefined,
        undefined,
        createStubExtensionToolContext(),
      ),
      /not readable/u,
    );
  });
});

test("rejects binary files", async () => {
  await withSkillsDirectory(async (directory, tool) => {
    await writeFile(join(directory, "demo", "binary.bin"), Buffer.from([0, 1, 2]));
    await assert.rejects(
      tool.execute(
        "call",
        { path: join(directory, "demo", "binary.bin") },
        undefined,
        undefined,
        createStubExtensionToolContext(),
      ),
      /not text/u,
    );
  });
});

test("reports a missing skills directory", async () => {
  const tool = createSkillReadTool(join(tmpdir(), "klein-missing-skills-directory"));
  await assert.rejects(
    tool.execute(
      "call",
      { path: "demo/SKILL.md" },
      undefined,
      undefined,
      createStubExtensionToolContext(),
    ),
    /Skills directory is not available/u,
  );
});

test("reads skill files across multiple directories and rejects outside files", async () => {
  await using temp = await createTempDir("klein-multi-skill-read-");
  const profileDir = join(temp.path, "profile-skills");
  const sharedDir = join(temp.path, "shared-skills");
  const outsideFile = join(temp.path, "outside.md");
  await mkdir(join(profileDir, "voice"), { recursive: true });
  await mkdir(join(sharedDir, "coding-task", "playbooks"), { recursive: true });
  await writeFile(join(profileDir, "voice", "SKILL.md"), "profile", "utf8");
  await writeFile(join(sharedDir, "coding-task", "playbooks", "bug-fix.md"), "playbook", "utf8");
  await writeFile(outsideFile, "secret", "utf8");

  const tool = createSkillReadTool([join(temp.path, "missing-skills"), profileDir, sharedDir]);
  const ctx = createStubExtensionToolContext();

  const fromProfile = await tool.execute(
    "call",
    { path: "voice/SKILL.md" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(textOf(fromProfile), "profile");

  const fromSharedRelative = await tool.execute(
    "call",
    { path: "coding-task/playbooks/bug-fix.md" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(textOf(fromSharedRelative), "playbook");

  const fromSharedAbsolute = await tool.execute(
    "call",
    { path: join(sharedDir, "coding-task", "playbooks", "bug-fix.md") },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(textOf(fromSharedAbsolute), "playbook");

  await assert.rejects(
    tool.execute("call", { path: outsideFile }, undefined, undefined, ctx),
    /not readable/u,
  );
});
