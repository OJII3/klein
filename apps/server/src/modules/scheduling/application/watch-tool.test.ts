import assert from "node:assert/strict";
import test from "node:test";

import type { WatchTool } from "../ports/watch-tool";
import { renderWatchToolSection } from "./watch-tool";

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

test("exposes owner-only watch tools only when ownerFeaturesAllowed is true", () => {
  const ownerTool: WatchTool = {
    name: "github_api",
    audience: "owner",
    description: "Read-only GitHub API.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async execute() {
      return {};
    },
  };

  const publicSection = renderWatchToolSection({ tools: [fetchTool, ownerTool] });
  assert.ok(publicSection);
  assert.match(publicSection, /fetch_content/u);
  assert.doesNotMatch(publicSection, /github_api/u);

  const ownerSection = renderWatchToolSection(
    { tools: [fetchTool, ownerTool] },
    { ownerFeaturesAllowed: true },
  );
  assert.ok(ownerSection);
  assert.match(ownerSection, /fetch_content/u);
  assert.match(ownerSection, /github_api/u);

  assert.equal(renderWatchToolSection({ tools: [ownerTool] }), undefined);
});
