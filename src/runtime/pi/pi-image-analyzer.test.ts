import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { ImageAnalysisError } from "@agents/core/image-analysis";
import {
  IMAGE_ANALYSIS_MAX_TOKENS,
  IMAGE_ANALYSIS_SYSTEM_PROMPT,
  PiImageAnalyzer,
} from "./pi-image-analyzer";
import { resolveConfiguredImageModel, resolveConfiguredModel } from "./pi-model-runtime";

test("sends image attachments to a one-shot analysis request", async () => {
  let received:
    | {
        modelId: string;
        systemPrompt?: string;
        content: unknown;
        maxTokens?: number;
        reasoning?: string;
      }
    | undefined;
  const modelRuntime: Pick<ModelRuntime, "completeSimple"> = {
    async completeSimple(model, context, options) {
      received = {
        content: context.messages[0]?.content,
        modelId: model.id,
        maxTokens: options?.maxTokens,
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
  assert.equal(received?.maxTokens, IMAGE_ANALYSIS_MAX_TOKENS);
  assert.equal(received?.reasoning, "medium");
  assert.deepEqual(received?.content, [
    {
      type: "text",
      text: "Analyze the attached image(s) for this user request:\nこの画像を確認して",
    },
    { type: "image", data: "c2VjcmV0", mimeType: "image/png" },
  ]);
});

test("adds the caller's focus to the analysis request", async () => {
  let receivedContent: unknown;
  const analyzer = new PiImageAnalyzer(
    {
      async completeSimple(_model, context) {
        receivedContent = context.messages[0]?.content;
        return {
          role: "assistant",
          content: [{ type: "text", text: "エラーは認証失敗です。" }],
          stopReason: "stop",
        } as never;
      },
    },
    resolveConfiguredImageModel("opencode-go", "kimi-k3"),
  );

  const analysis = await analyzer.analyze({
    text: "この画面のエラーを見て",
    images: [{ data: "c2VjcmV0", mimeType: "image/png" }],
    focus: "表示されているエラーメッセージだけ",
  });

  assert.equal(analysis, "エラーは認証失敗です。");
  assert.deepEqual(receivedContent, [
    {
      type: "text",
      text:
        "Analyze the attached image(s) for this user request:\nこの画面のエラーを見て\n\n" +
        "Focus only on what the caller needs:\n表示されているエラーメッセージだけ",
    },
    { type: "image", data: "c2VjcmV0", mimeType: "image/png" },
  ]);
});

test("classifies a rate limit response from the provider", async () => {
  const analyzer = new PiImageAnalyzer(
    {
      async completeSimple() {
        return {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: '429: {"type":"server_error"}',
        } as never;
      },
    },
    resolveConfiguredImageModel("opencode-go", "kimi-k3"),
  );

  await assert.rejects(
    analyzer.analyze({ text: "x", images: [{ data: "c2VjcmV0", mimeType: "image/png" }] }),
    (error: unknown) => {
      assert.ok(error instanceof ImageAnalysisError);
      assert.deepEqual(error.failure, {
        reason: "rate_limited",
        status: 429,
        retryable: true,
      });
      return true;
    },
  );
});

test("classifies a thrown provider error", async () => {
  const analyzer = new PiImageAnalyzer(
    {
      async completeSimple() {
        throw new Error("HTTP 503 upstream unavailable");
      },
    },
    resolveConfiguredImageModel("opencode-go", "kimi-k3"),
  );

  await assert.rejects(
    analyzer.analyze({ text: "x", images: [{ data: "c2VjcmV0", mimeType: "image/png" }] }),
    (error: unknown) => {
      assert.ok(error instanceof ImageAnalysisError);
      assert.deepEqual(error.failure, {
        reason: "http_error",
        status: 503,
        retryable: true,
      });
      return true;
    },
  );
});

test("classifies an empty analysis result", async () => {
  const analyzer = new PiImageAnalyzer(
    {
      async completeSimple() {
        return { role: "assistant", content: [], stopReason: "stop" } as never;
      },
    },
    resolveConfiguredImageModel("opencode-go", "kimi-k3"),
  );

  await assert.rejects(
    analyzer.analyze({ text: "x", images: [{ data: "c2VjcmV0", mimeType: "image/png" }] }),
    (error: unknown) => {
      assert.ok(error instanceof ImageAnalysisError);
      assert.deepEqual(error.failure, { reason: "empty_result", retryable: true });
      return true;
    },
  );
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
