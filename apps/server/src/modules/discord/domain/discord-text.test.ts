import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEscapedNewlines } from "./discord-text";

test("replaces an escaped line break in prose", () => {
  assert.equal(normalizeEscapedNewlines("……勘違いしてた\\nごめん"), "……勘違いしてた\nごめん");
});

test("replaces multiple escaped line breaks", () => {
  assert.equal(normalizeEscapedNewlines("一行目\\n二行目\\n三行目"), "一行目\n二行目\n三行目");
});

test("preserves a fenced code block", () => {
  assert.equal(
    normalizeEscapedNewlines("説明\n```cpp\ncout << '\\n';\n```\n後\\n末"),
    "説明\n```cpp\ncout << '\\n';\n```\n後\n末",
  );
});

test("preserves a tilde fenced code block", () => {
  assert.equal(
    normalizeEscapedNewlines("説明\n~~~\na\\nb\n~~~\n後\\n末"),
    "説明\n~~~\na\\nb\n~~~\n後\n末",
  );
});

test("preserves an unterminated fence through the end of the text", () => {
  assert.equal(normalizeEscapedNewlines("前\n```\na\\nb"), "前\n```\na\\nb");
});

test("preserves an inline code span", () => {
  assert.equal(normalizeEscapedNewlines("コード `a\\nb` です"), "コード `a\\nb` です");
});

test("normalizes prose around code and leaves the code untouched", () => {
  assert.equal(
    normalizeEscapedNewlines("前\\n`x\\ny`\n```\nc\\nd\n```\n後\\n末"),
    "前\n`x\\ny`\n```\nc\\nd\n```\n後\n末",
  );
});

test("returns text without escaped line breaks unchanged", () => {
  assert.equal(normalizeEscapedNewlines("そのままの文章"), "そのままの文章");
});
