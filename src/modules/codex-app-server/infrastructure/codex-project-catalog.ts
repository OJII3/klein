import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface CodexProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly isDefault: boolean;
}

export interface CodexProjectCatalogOptions {
  readonly defaultWorkspace: string;
  readonly codexHome?: string;
}

export class CodexProjectCatalog {
  private readonly defaultWorkspace: string;
  private readonly configPath: string;

  constructor(options: CodexProjectCatalogOptions) {
    this.defaultWorkspace = resolve(options.defaultWorkspace);
    const codexHome = resolve(
      options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    );
    this.configPath = join(codexHome, "config.toml");
  }

  async list(): Promise<readonly CodexProject[]> {
    const config = await readFile(this.configPath, "utf8");
    const paths = new Set(readProjectPaths(config));
    const projects = [...paths].map((path) => this.toProject(path, path === this.defaultWorkspace));

    return projects.sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
  }

  async resolve(project?: string): Promise<CodexProject> {
    if (!project) return this.toProject(this.defaultWorkspace, true);

    const projects = await this.list();
    const selected = projects.find(
      (candidate) => candidate.id === project || candidate.path === project,
    );
    if (!selected) throw new Error(`Codex project was not found in config.toml: ${project}`);
    return selected;
  }

  private toProject(path: string, isDefault: boolean): CodexProject {
    const resolvedPath = resolve(path);
    return {
      id: resolvedPath,
      name: basename(resolvedPath),
      path: resolvedPath,
      isDefault,
    };
  }
}

function readProjectPaths(config: string): readonly string[] {
  const paths: string[] = [];
  for (const line of config.split("\n")) {
    const match = line.match(/^\s*\[projects\."((?:\\.|[^"])*)"\]\s*(?:#.*)?$/);
    if (match?.[1]) paths.push(decodeTomlBasicString(match[1]));
  }
  return paths;
}

function decodeTomlBasicString(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|["\\bfnrt])/g, (_, escape: string) => {
    switch (escape) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    }
  });
}
