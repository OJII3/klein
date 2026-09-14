import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export interface CodexProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly isDefault: boolean;
}

export interface CodexProjectCatalogOptions {
  readonly defaultWorkspace: string;
  readonly projectsRoot?: string;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export class CodexProjectCatalog {
  private readonly defaultWorkspace: string;
  private readonly projectsRoot: string;

  constructor(options: CodexProjectCatalogOptions) {
    this.defaultWorkspace = resolve(options.defaultWorkspace);
    this.projectsRoot = resolve(options.projectsRoot ?? dirname(this.defaultWorkspace));
  }

  async list(): Promise<readonly CodexProject[]> {
    const projects = new Map<string, CodexProject>();
    projects.set(this.defaultWorkspace, this.toProject(this.defaultWorkspace, true));

    for (const entry of await readdir(this.projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = resolve(this.projectsRoot, entry.name);
      if (!projects.has(path)) projects.set(path, this.toProject(path, false));
    }

    return [...projects.values()].sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }

  async resolve(project?: string): Promise<CodexProject> {
    if (!project) return this.toProject(this.defaultWorkspace, true);

    const projects = await this.list();
    const named = projects.find(
      (candidate) =>
        candidate.id === project || candidate.name === project || candidate.path === project,
    );
    if (named) return named;

    const candidatePath = resolve(isAbsolute(project) ? project : this.projectsRoot, project);
    if (!isWithin(this.projectsRoot, candidatePath) && candidatePath !== this.defaultWorkspace) {
      throw new Error(`Codex project is outside the configured projects root: ${project}`);
    }

    const candidateStats = await stat(candidatePath).catch(() => undefined);
    if (!candidateStats?.isDirectory()) {
      throw new Error(`Codex project directory was not found: ${project}`);
    }

    return this.toProject(candidatePath, candidatePath === this.defaultWorkspace);
  }

  private toProject(path: string, isDefault: boolean): CodexProject {
    const relativePath = relative(this.projectsRoot, path);
    return {
      id: relativePath && !relativePath.startsWith("..") ? relativePath : basename(path),
      name: basename(path),
      path,
      isDefault,
    };
  }
}
