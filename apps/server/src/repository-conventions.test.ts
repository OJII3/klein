import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectSourceComments, isJustifiedComment } from "./testing/comment-policy";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const commentBaselinePath = join(repositoryRoot, "apps/server/src/testing/comment-baseline.json");

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/u;

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

function readCommentBaseline(): ReadonlySet<string> {
  const value: unknown = JSON.parse(readFileSync(commentBaselinePath, "utf8"));
  if (!Array.isArray(value)) throw new TypeError("comment-baseline.json must be an array");
  const texts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new TypeError("comment-baseline.json must contain strings");
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
