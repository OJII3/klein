import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadConfig } from "../src/app/config";
import { migrateLegacyReminder } from "../src/modules/scheduling/infrastructure/legacy-reminder-migration";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const overwrite = args.includes("--overwrite");
const agentDirArgument = readOption(args, "--agent-dir");

const config = await loadConfig();
const agentDir = resolve(agentDirArgument ?? config.runtime.agentDir);
const sourceDirectory = resolve(agentDir, "reminders");
const targetDirectory = resolve(agentDir, "schedules");
const ownerUserId = config.owner?.discord.userId;

const files = await listJsonFiles(sourceDirectory);
if (files.length === 0) {
  console.info(`移行対象のリマインダーはありません: ${sourceDirectory}`);
  process.exit(0);
}

console.info(
  `${apply ? "APPLY" : "DRY RUN"}: ${files.length} 件を ${targetDirectory} へ移行します。`,
);
if (!apply) console.info("書き込むには --apply を指定してください。");

let migrated = 0;
let skipped = 0;
let failed = 0;

for (const file of files) {
  try {
    const source = JSON.parse(await readFile(resolve(sourceDirectory, file), "utf8")) as unknown;
    const task = migrateLegacyReminder(source, ownerUserId ? { ownerUserId } : {});
    const target = resolve(targetDirectory, `${encodeURIComponent(task.id)}.json`);
    if (!overwrite && (await exists(target))) {
      console.info(`SKIP ${file}: 移行先に ${task.id} が既にあります。`);
      skipped += 1;
      continue;
    }
    if (apply) {
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(target, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    }
    console.info(`${apply ? "WRITE" : "PLAN"} ${file} -> ${target}`);
    migrated += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.info(
  `${apply ? "完了" : "予定"}: 移行 ${migrated} 件 / スキップ ${skipped} 件 / 失敗 ${failed} 件`,
);
if (failed > 0) process.exitCode = 1;

function readOption(values: readonly string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index === -1) return undefined;
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} にはパスを指定してください。`);
  }
  return value;
}

async function listJsonFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
