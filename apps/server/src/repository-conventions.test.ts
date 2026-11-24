import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

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

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
