import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectSourceComments, isJustifiedComment } from "./testing/comment-policy";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const commentBaselinePath = join(repositoryRoot, "apps/server/src/testing/comment-baseline.json");

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/u;

const ALLOWED_MARKDOWN_PATTERNS = [
  /^README\.md$/u,
  /^AGENTS\.md$/u,
  /^config\/.+\.md$/u,
  /^\.agents\/.+\.md$/u,
  /^docs\/[^/]+-protocol\.md$/u,
  /^apps\/server\/src\/modules\/vad\/infrastructure\/[^/]+\/README\.md$/u,
] as const;

const IGNORED_DIRECTORIES = new Set([".direnv", ".git", ".runtime", "dist", "node_modules"]);

test("keeps the web UI in English", () => {
  const files = [
    join(repositoryRoot, "apps/web/index.html"),
    ...listFiles(join(repositoryRoot, "apps/web/src")),
  ];

  const violations = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        JAPANESE.test(line)
          ? [`${relative(repositoryRoot, file)}:${index + 1}: ${line.trim()}`]
          : [],
      ),
  );

  assert.deepEqual(
    violations,
    [],
    `The web UI is English only. Move Japanese copy to the Discord character's reply.\n${violations.join("\n")}`,
  );
});

test("keeps non-character Discord replies in container messages", () => {
  const files = [
    ...listFiles(join(repositoryRoot, "apps/server/src/modules/discord")),
    ...listFiles(join(repositoryRoot, "apps/server/src/modules/secrets")),
  ].filter((file) => file.endsWith(".ts"));

  const violations = files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/reply\(\s*(?:options:\s*)?\{\s*content\s*:/gu)].map(
      (match) =>
        `${relative(repositoryRoot, file)}:${source.slice(0, match.index).split("\n").length}`,
    );
  });

  assert.deepEqual(
    violations,
    [],
    `Interaction replies must use createTextContainerMessage or createEphemeralTextContainerMessage, not content.\n${violations.join("\n")}`,
  );
});

test("requires new comments to justify themselves", () => {
  const baseline = readCommentBaseline();
  const unjustified = collectSourceComments(repositoryRoot).filter(
    (comment) => !isJustifiedComment(comment.text) && !baseline.has(comment.text),
  );

  const violations = unjustified.map(
    (comment) => `${comment.file}:${comment.line}: ${comment.text}`,
  );
  assert.deepEqual(
    violations,
    [],
    [
      "A new comment must state a constraint the code cannot show, starting with one of:",
      "Why:, Security:, External:, Protocol:, Format:, Config:",
      "Delete it if it only restates the code or a test.",
      ...violations,
    ].join("\n"),
  );
});

test("prevents stray markdown docs in the repository", () => {
  const markdownFiles = listMarkdownFiles(repositoryRoot).map((file) =>
    relative(repositoryRoot, file).split("\\").join("/"),
  );
  const violations = markdownFiles.filter(
    (file) => !ALLOWED_MARKDOWN_PATTERNS.some((pattern) => pattern.test(file)),
  );

  assert.deepEqual(
    violations,
    [],
    [
      "Do not add design docs, specs, plans, or notes as .md files in the repository.",
      "Encode invariants and constraints in types, lint rules, and tests instead.",
      ...violations,
    ].join("\n"),
  );
});

function readCommentBaseline(): ReadonlySet<string> {
  const value: unknown = JSON.parse(readFileSync(commentBaselinePath, "utf8"));
  if (!Array.isArray(value)) throw new TypeError("comment-baseline.json must be an array");
  const texts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string")
      throw new TypeError("comment-baseline.json must contain strings");
    texts.push(entry);
  }
  return new Set(texts);
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function listMarkdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return IGNORED_DIRECTORIES.has(entry.name)
        ? []
        : listMarkdownFiles(join(directory, entry.name));
    }
    return entry.name.endsWith(".md") ? [join(directory, entry.name)] : [];
  });
}
