import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const generatedDirectory = resolve(projectRoot, "src/modules/codex-app-server/protocol/generated");
const codexCli = process.env.KLEIN_CODEX_CLI ?? "codex";

const roots = [
  "InitializeParams.ts",
  "InitializeResponse.ts",
  "v2/ThreadStartParams.ts",
  "v2/TurnStartParams.ts",
];

const temporaryDirectory = await mkdtemp(join(tmpdir(), "klein-codex-protocol-"));

try {
  const result = Bun.spawnSync([
    codexCli,
    "app-server",
    "generate-ts",
    "--out",
    temporaryDirectory,
  ]);

  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Failed to generate Codex app-server types${stderr ? `: ${stderr}` : ""}`);
  }

  await rm(generatedDirectory, { force: true, recursive: true });
  const copied = new Set<string>();

  async function copyType(relativePath: string): Promise<void> {
    if (copied.has(relativePath)) return;
    copied.add(relativePath);

    const sourcePath = join(temporaryDirectory, relativePath);
    const content = await readFile(sourcePath, "utf8");
    const imports = [...content.matchAll(/from "(\.{1,2}\/[^".]+)"/g)].map(
      ([, importPath]) => importPath,
    );

    const destinationPath = join(generatedDirectory, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await Bun.write(destinationPath, content.replace(/from "(\.{1,2}\/[^".]+)"/g, 'from "$1.js"'));

    for (const importPath of imports) {
      const dependencyPath = join(dirname(relativePath), `${importPath}.ts`);
      await copyType(dependencyPath);
    }
  }

  for (const root of roots) {
    await copyType(root);
  }

  const files = await listFiles(generatedDirectory);
  console.log(`Generated ${files.length} Codex app-server type files.`);
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else {
      files.push(entryPath);
    }
  }

  return files;
}
