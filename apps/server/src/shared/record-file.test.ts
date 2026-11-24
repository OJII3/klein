import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { isRecord } from "./type-guards";
import { quarantineFile, readJsonRecord } from "./record-file";
import { createTempDir } from "../testing/temp-dir";

interface Record {
  readonly id: string;
}

function parseRecord(value: unknown): Record {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("record is invalid");
  }
  return { id: value.id };
}

const corruptName = /^record\.json\.\d+\.[0-9a-f-]+\.corrupt$/u;

test("reads and parses a valid record", async () => {
  await using temp = await createTempDir("klein-record-file-");
  const path = join(temp.path, "record.json");
  await writeFile(path, JSON.stringify({ id: "record-1" }), "utf8");

  assert.deepEqual(await readJsonRecord(path, parseRecord), { id: "record-1" });
  assert.deepEqual(await readdir(temp.path), ["record.json"]);
});

test("returns undefined for a missing file without creating a quarantine directory", async () => {
  await using temp = await createTempDir("klein-record-file-");

  assert.equal(await readJsonRecord(join(temp.path, "missing.json"), parseRecord), undefined);
  assert.deepEqual(await readdir(temp.path), []);
});

test("quarantines a file that is not valid JSON", async () => {
  await using temp = await createTempDir("klein-record-file-");
  const path = join(temp.path, "record.json");
  await writeFile(path, "{not json", "utf8");

  assert.equal(await readJsonRecord(path, parseRecord), undefined);
  assert.deepEqual(await readdir(temp.path), ["corrupt"]);
  const quarantined = await readdir(join(temp.path, "corrupt"));
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0] ?? "", corruptName);
});

test("quarantines a record that fails validation", async () => {
  await using temp = await createTempDir("klein-record-file-");
  const path = join(temp.path, "record.json");
  await writeFile(path, JSON.stringify({ id: 1 }), "utf8");

  assert.equal(await readJsonRecord(path, parseRecord), undefined);
  const quarantined = await readdir(join(temp.path, "corrupt"));
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0] ?? "", corruptName);
});

test("reports the corrupt path and error before quarantining", async () => {
  await using temp = await createTempDir("klein-record-file-");
  const path = join(temp.path, "record.json");
  await writeFile(path, JSON.stringify({ id: 1 }), "utf8");
  const calls: Array<{ path: string; error: unknown }> = [];

  const record = await readJsonRecord(path, parseRecord, {
    onCorrupt: (corruptPath, error) => calls.push({ path: corruptPath, error }),
  });

  assert.equal(record, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, path);
  assert.ok(calls[0]?.error instanceof Error);
});

test("still returns undefined when the quarantine move fails", async () => {
  await using temp = await createTempDir("klein-record-file-");
  const path = join(temp.path, "record.json");
  await writeFile(path, "{not json", "utf8");
  await writeFile(join(temp.path, "corrupt"), "a file blocks the quarantine directory", "utf8");

  assert.equal(await readJsonRecord(path, parseRecord), undefined);
  assert.equal(await readFile(path, "utf8"), "{not json");
});

test("throws for a read error that is not a missing file", async () => {
  await using temp = await createTempDir("klein-record-file-");
  const path = join(temp.path, "record.json");
  await mkdir(path);

  await assert.rejects(readJsonRecord(path, parseRecord));
  assert.deepEqual(await readdir(temp.path), ["record.json"]);
});

test("quarantining a missing file is a no-op", async () => {
  await using temp = await createTempDir("klein-record-file-");

  await quarantineFile(join(temp.path, "missing.json"));
});
