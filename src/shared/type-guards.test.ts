import assert from "node:assert/strict";
import test from "node:test";

import { getErrorCode, isFileNotFound, isRecord, parseJson } from "./type-guards";

test("isRecord accepts plain objects and excludes null and arrays", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord("text"), false);
  assert.equal(isRecord(42), false);
});

test("parseJson returns unknown values", () => {
  assert.deepEqual(parseJson('{"ok":true}'), { ok: true });
});

test("getErrorCode and isFileNotFound extract string error codes safely", () => {
  const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
  const other = Object.assign(new Error("other"), { code: "EACCES" });
  assert.equal(getErrorCode(enoent), "ENOENT");
  assert.equal(getErrorCode(new Error("plain")), undefined);
  assert.equal(getErrorCode("ENOENT"), undefined);
  assert.equal(isFileNotFound(enoent), true);
  assert.equal(isFileNotFound(other), false);
});
