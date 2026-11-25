import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  formatSkillsForPrompt,
  loadSkills,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import type {
  SkillAvailability,
  SkillDiagnostic,
  SkillFileContent,
  SkillFileSummary,
  SkillReader,
  SkillRequirement,
  SkillSummary,
  SkillsReport,
} from "@klein/webui-api";

import { skillRequirements, type SkillAudienceCapabilities } from "@runtime/pi/skill-availability";
import { SkillFileError, readSkillFile } from "@runtime/pi/skill-file";

export interface PiSkillReaderOptions {
  readonly profile: string;
  readonly skillsDirectory: string;
  readonly agentDirectory: string;
  readonly capabilities: SkillAudienceCapabilities;
}

interface LoadedSkills {
  readonly root: string;
  readonly directory: string;
  readonly skills: readonly Skill[];
  readonly diagnostics: readonly ResourceDiagnostic[];
}

export class PiSkillReader implements SkillReader {
  constructor(private readonly options: PiSkillReaderOptions) {}

  async list(): Promise<SkillsReport> {
    const loaded = this.load();
    const directoryStat = await stat(loaded.root).catch(() => undefined);
    const directoryExists = directoryStat?.isDirectory() === true;
    const skills = directoryExists
      ? await Promise.all(
          loaded.skills.map((skill) => this.toSummary(skill, loaded.root, loaded.directory)),
        )
      : [];

    return {
      profile: this.options.profile,
      directory: loaded.directory,
      directoryExists,
      skills: skills.toSorted((left, right) => left.name.localeCompare(right.name)),
      diagnostics: directoryExists
        ? loaded.diagnostics.map((diagnostic) =>
            toWireDiagnostic(diagnostic, loaded.root, loaded.directory),
          )
        : [],
    };
  }

  async readFile(skillName: string, path: string): Promise<SkillFileContent | undefined> {
    const skill = this.load().skills.find((candidate) => candidate.name === skillName);
    if (!skill) return undefined;

    try {
      const file = await readSkillFile(skill.baseDir, path);
      return { path: toPosixPath(relative(skill.baseDir, file.path)), content: file.content };
    } catch (error) {
      if (!(error instanceof SkillFileError)) throw error;
      if (error.reason === "missing" || error.reason === "not-file") return undefined;
      if (error.reason === "unsafe") {
        throw new Error(`Skill file path is outside the skill directory: ${path}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private load(): LoadedSkills {
    const root = resolve(this.options.skillsDirectory);
    const result = loadSkills({
      cwd: process.cwd(),
      agentDir: this.options.agentDirectory,
      skillPaths: [root],
      includeDefaults: false,
    });

    return {
      root,
      directory: displayDirectory(root),
      skills: result.skills,
      diagnostics: result.diagnostics,
    };
  }

  private async toSummary(skill: Skill, root: string, directory: string): Promise<SkillSummary> {
    const requirements = skillRequirements(skill.name);

    return {
      name: skill.name,
      description: skill.description,
      directory: join(directory, toPosixPath(relative(root, skill.baseDir))),
      files: await listSkillFiles(skill.baseDir),
      modelInvocable: !skill.disableModelInvocation,
      requirements,
      availability: availabilityFor(requirements, this.options.capabilities),
      promptEntry: promptEntryFor(skill),
    };
  }
}

function displayDirectory(root: string): string {
  const relativePath = relative(process.cwd(), root);
  return isOutside(relativePath) ? root : toPosixPath(relativePath);
}

function toWireDiagnostic(
  diagnostic: ResourceDiagnostic,
  root: string,
  directory: string,
): SkillDiagnostic {
  return {
    type: diagnostic.type === "error" ? "error" : "warning",
    message: diagnostic.message,
    ...(diagnostic.path ? { path: displayPath(diagnostic.path, root, directory) } : {}),
  };
}

function displayPath(path: string, root: string, directory: string): string {
  const fromCwd = relative(process.cwd(), path);
  if (!isOutside(fromCwd)) return toPosixPath(fromCwd);
  const fromRoot = relative(root, path);
  if (!isOutside(fromRoot) && fromRoot !== "") return join(directory, toPosixPath(fromRoot));
  return basename(path);
}

async function listSkillFiles(directory: string): Promise<SkillFileSummary[]> {
  const files: SkillFileSummary[] = [];

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await stat(path);
      files.push({ path: toPosixPath(relative(directory, path)), size: fileStat.size });
    }
  };
  await walk(directory);

  return files.toSorted((left, right) => {
    if (left.path === "SKILL.md") return -1;
    if (right.path === "SKILL.md") return 1;
    return left.path.localeCompare(right.path);
  });
}

function availabilityFor(
  requirements: readonly SkillRequirement[],
  capabilities: SkillAudienceCapabilities,
): SkillAvailability {
  return {
    conversation: requirements.every((requirement) => capabilities.conversation[requirement]),
    ownerWorker: requirements.every((requirement) => capabilities.ownerWorker[requirement]),
    linkedUserWorker: requirements.every(
      (requirement) => capabilities.linkedUserWorker[requirement],
    ),
  };
}

function promptEntryFor(skill: Skill): string | null {
  if (skill.disableModelInvocation) return null;
  const formatted = formatSkillsForPrompt([skill], "read");
  const match = /<skill>[\s\S]*?<\/skill>/u.exec(formatted);
  return match?.[0].trim() ?? null;
}

function isOutside(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}
