import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { IMAGE_ANALYSIS_SYSTEM_PROMPT, PiImageAnalyzer } from "./pi-image-analyzer.js";
import { resolveConfiguredImageModel, resolveConfiguredModel } from "./pi-agent-runtime.js";

test("sends image attachments to a one-shot analysis request", async () => {
  let received:
    | {
        modelId: string;
        systemPrompt?: string;
        content: unknown;
        reasoning?: string;
      }
    | undefined;
  const modelRuntime: Pick<ModelRuntime, "completeSimple"> = {
    async completeSimple(model, context, options) {
      received = {
        content: context.messages[0]?.content,
        modelId: model.id,
        reasoning: options?.reasoning,
        systemPrompt: context.systemPrompt,
      };
      return {
        role: "assistant",
        content: [{ type: "text", text: "画像の解析結果" }],
        stopReason: "stop",
      } as never;
    },
  };
  const analyzer = new PiImageAnalyzer(
    modelRuntime,
    resolveConfiguredImageModel("opencode-go", "kimi-k3"),
    "medium",
  );

  const analysis = await analyzer.analyze({
    text: "この画像を確認して",
    images: [{ data: "c2VjcmV0", mimeType: "image/png" }],
  });

  assert.equal(analysis, "画像の解析結果");
  assert.equal(received?.modelId, "kimi-k3");
  assert.equal(received?.systemPrompt, IMAGE_ANALYSIS_SYSTEM_PROMPT);
  assert.equal(received?.reasoning, "medium");
  assert.deepEqual(received?.content, [
    {
      type: "text",
      text: "Analyze the attached image(s) for this user request:\nこの画像を確認して",
    },
    { type: "image", data: "c2VjcmV0", mimeType: "image/png" },
  ]);
});

test("rejects a configured image model without image input", () => {
  assert.throws(
    () => resolveConfiguredImageModel("opencode-go", "glm-5.3"),
    /Configured Pi image model does not support image input: opencode-go\/glm-5.3/,
  );
});

test("still resolves a normal text-only model", () => {
  const model = resolveConfiguredModel("opencode-go", "glm-5.3");

  assert.equal(model.input.includes("image"), false);
});
