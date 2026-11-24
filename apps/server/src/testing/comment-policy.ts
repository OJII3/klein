import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface SourceComment {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const JUSTIFICATION_PREFIXES = [
  "Why:",
  "Security:",
  "External:",
  "Protocol:",
  "Format:",
  "Config:",
];
const DIRECTIVE_PREFIXES = ["eslint-", "oxlint-", "@ts-", "prettier-", "biome-"];

export function collectSourceComments(repositoryRoot: string): SourceComment[] {
  return ["apps", "packages"].flatMap((directory) =>
    collectCommentsInDirectory(repositoryRoot, join(repositoryRoot, directory)),
  );
}

export function isJustifiedComment(text: string): boolean {
  if (DIRECTIVE_PREFIXES.some((prefix) => text.startsWith(prefix))) return true;
  return JUSTIFICATION_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function collectCommentsInDirectory(repositoryRoot: string, directory: string): SourceComment[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist"
        ? []
        : collectCommentsInDirectory(repositoryRoot, path);
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) return [];
    return scanComments(relative(repositoryRoot, path), readFileSync(path, "utf8"));
  });
}

function scanComments(file: string, source: string): SourceComment[] {
  const comments: SourceComment[] = [];
  let state: "code" | "line" | "block" | "single" | "double" | "template" | "regex" = "code";
  let previousSignificant = "";
  let start = 0;
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (character === "/" && next === "/") {
        state = "line";
        start = index;
        index += 2;
        continue;
      }
      if (character === "/" && next === "*") {
        state = "block";
        start = index;
        index += 2;
        continue;
      }
      if (character === "/" && canStartRegex(previousSignificant)) {
        state = "regex";
        index += 1;
        continue;
      }
      if (character === '"') state = "double";
      else if (character === "'") state = "single";
      else if (character === "`") state = "template";
      if (character.trim().length > 0) previousSignificant = character;
      index += 1;
      continue;
    }

    if (state === "regex") {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "/" || character === "\n") {
        state = "code";
        previousSignificant = "/";
      }
      index += 1;
      continue;
    }

    if (state === "line") {
      if (character === "\n") {
        comments.push({
          file,
          line: lineAt(source, start),
          text: normalize(source.slice(start, index)),
        });
        state = "code";
      }
      index += 1;
      continue;
    }

    if (state === "block") {
      if (character === "*" && next === "/") {
        comments.push({
          file,
          line: lineAt(source, start),
          text: normalize(source.slice(start, index + 2)),
        });
        state = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (character === "\\") {
      index += 2;
      continue;
    }
    if (
      (state === "single" && character === "'") ||
      (state === "double" && character === '"') ||
      (state === "template" && character === "`")
    ) {
      state = "code";
      previousSignificant = character;
    }
    index += 1;
  }

  return comments;
}

function canStartRegex(previousSignificant: string): boolean {
  return previousSignificant.length === 0 || "([{,;:=!&|?+-*%^~<>".includes(previousSignificant);
}

function lineAt(source: string, position: number): number {
  return source.slice(0, position).split("\n").length;
}

function normalize(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .replace(/^\/\//, "")
    .split("\n")
    .map((line) => line.trim().replace(/^\*\s?/, ""))
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
}
