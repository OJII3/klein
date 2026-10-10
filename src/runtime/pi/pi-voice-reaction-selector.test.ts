import assert from "node:assert/strict";
import test from "node:test";

import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { VoiceReactionPreset } from "@modules/discord/ports/voice-reaction-selector";
import {
  PiVoiceReactionSelector,
  VOICE_REACTION_CLASSIFICATION_INSTRUCTIONS,
} from "./pi-voice-reaction-selector";

const model = { id: "jev", provider: "test" } as ClassifierModel<ClassifierApi>;
const presets: VoiceReactionPreset[] = [
  { id: "ack", text: "うん、聞いてるよ", description: "話を受け止める", audioFile: "ack.ogg" },
  { id: "think", text: "ちょっと考えるね", description: "返答を考える", audioFile: "think.ogg" },
  {
    id: "empathy",
    text: "それは大変だったね",
    description: "困難への共感",
    audioFile: "empathy.ogg",
  },
];

test("pi includes the configured Workers AI Clef Flash classifier", () => {
  const model = builtinModels().getModelOfType(
    "classifier",
    "cloudflare-workers-ai",
    "@cf/cloudflare/clef-flash",
  );

  assert.equal(model?.api, "cloudflare-workers-ai-system-one");
});

function result(choice: string, confidence = 0.9, stopReason = "stop") {
  return {
    answers: { reaction: { type: "choice", choice, confidence, probabilities: {} } },
    stopReason,
  } as never;
}

test("classifies among actual preset phrases with transcript context and accepts low confidence", async () => {
  let call:
    | {
        modelId: string;
        context: Parameters<ModelRuntime["classify"]>[1];
        signal?: AbortSignal;
      }
    | undefined;
  const runtime: Pick<ModelRuntime, "classify"> = {
    async classify(receivedModel, context, options) {
      call = { modelId: receivedModel.id, context, signal: options?.signal };
      return result("think", 0.01);
    },
  };
  const selector = new PiVoiceReactionSelector(runtime, model, presets);
  const controller = new AbortController();

  const selected = await selector.select(
    { text: "これどう思う？", recentTranscripts: ["さっきの話だけど"] },
    controller.signal,
  );

  assert.equal(selected, "think");
  assert.equal(call?.modelId, "jev");
  assert.equal(call?.signal, controller.signal);
  assert.deepEqual(call?.context.state, {
    userTranscript: "これどう思う？",
    recentTranscripts: ["さっきの話だけど"],
    lastReaction: "",
    assistantPersona: "淡々としていて少し眠そう。効率優先だがフレンドリーなクライン。",
  });
  assert.deepEqual(call?.context.questions.reaction?.criteria, {
    ack: "「うん、聞いてるよ」 — 話を受け止める",
    think: "「ちょっと考えるね」 — 返答を考える",
    empathy: "「それは大変だったね」 — 困難への共感",
  });
  assert.equal(
    call?.context.questions.reaction?.instructions,
    VOICE_REACTION_CLASSIFICATION_INSTRUCTIONS,
  );
});

test("falls back to the first candidate for invalid and failed classifier results", async () => {
  const responses = [result("unknown-id"), result("think", 1, "error")];
  const runtime: Pick<ModelRuntime, "classify"> = {
    async classify() {
      return responses.shift() as never;
    },
  };
  const selector = new PiVoiceReactionSelector(runtime, model, presets);
  const input = { text: "質問", recentTranscripts: [] };
  const signal = new AbortController().signal;

  assert.equal(await selector.select(input, signal), "ack");
  assert.equal(await selector.select(input, signal), "ack");
});

test("excludes the previous preset when alternatives exist and retains it for a single candidate", async () => {
  const criteriaSeen: Array<Record<string, string>> = [];
  const runtime: Pick<ModelRuntime, "classify"> = {
    async classify(_model, context) {
      const criteria =
        context.questions.reaction?.type === "choice" ? context.questions.reaction.criteria : {};
      criteriaSeen.push(criteria);
      return result(Object.keys(criteria)[0] ?? "");
    },
  };
  const selector = new PiVoiceReactionSelector(runtime, model, presets);
  const signal = new AbortController().signal;

  assert.equal(
    await selector.select({ text: "続き", recentTranscripts: [], lastReaction: "ack" }, signal),
    "think",
  );
  assert.deepEqual(Object.keys(criteriaSeen[0] ?? {}), ["think", "empathy"]);

  const singleSelector = new PiVoiceReactionSelector(runtime, model, [presets[0]!]);
  assert.equal(
    await singleSelector.select(
      { text: "続き", recentTranscripts: [], lastReaction: "ack" },
      signal,
    ),
    "ack",
  );
  assert.deepEqual(Object.keys(criteriaSeen[1] ?? {}), ["ack"]);
});

test("returns undefined only when cancelled and falls back on thrown errors otherwise", async () => {
  let calls = 0;
  const runtime: Pick<ModelRuntime, "classify"> = {
    async classify() {
      calls++;
      throw new Error("classifier unavailable");
    },
  };
  const selector = new PiVoiceReactionSelector(runtime, model, presets);
  const aborted = new AbortController();
  aborted.abort();

  assert.equal(
    await selector.select({ text: "質問", recentTranscripts: [] }, aborted.signal),
    undefined,
  );
  assert.equal(calls, 0);
  assert.equal(
    await selector.select({ text: "質問", recentTranscripts: [] }, new AbortController().signal),
    "ack",
  );
  assert.equal(calls, 1);
});
