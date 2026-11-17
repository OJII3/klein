import assert from "node:assert/strict";
import test from "node:test";

import { renderWatchToolSection, type WatchTool } from "./watch-tool";

const fetchTool: WatchTool = {
  name: "fetch_content",
  description: "Fetch a URL as text.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  outputSchema: {
    type: "object",
    properties: { body: { type: "string" } },
    required: ["body"],
  },
  async execute() {
    return { body: "" };
  },
};

test("renders watch tool declarations as TypeScript", () => {
  const section = renderWatchToolSection({ tools: [fetchTool] });
  assert.ok(section);
  assert.match(section, /tools\.<name>/u);
  assert.match(section, /declare const tools/u);
  assert.match(section, /fetch_content/u);
  assert.match(section, /Fetch a URL as text/u);
  assert.match(section, /Promise<\{ body: string; \}>/u);
});

test("returns undefined without watch tools", () => {
  assert.equal(renderWatchToolSection({ tools: [] }), undefined);
});
