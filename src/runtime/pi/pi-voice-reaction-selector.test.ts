import assert from "node:assert/strict";
import test from "node:test";

import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  PiVoiceReactionSelector,
  VOICE_REACTION_CLASSIFICATION_INSTRUCTIONS,
} from "./pi-voice-reaction-selector";

const model = { id: "jev", provider: "test" } as ClassifierModel<ClassifierApi>;

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

test("uses pi classify with transcript context and returns a confident valid choice", async () => {
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
      return result("thinking");
    },
  };
  const selector = new PiVoiceReactionSelector(runtime, model);
  const controller = new AbortController();

  const reaction = await selector.select(
    {
      text: "これどう思う？",
      recentTranscripts: ["さっきの話だけど"],
      lastReaction: "neutral",
    },
    controller.signal,
  );

  assert.equal(reaction, "thinking");
  assert.equal(call?.modelId, "jev");
  assert.equal(call?.signal, controller.signal);
  assert.deepEqual(call?.context.state, {
    userTranscript: "これどう思う？",
    recentTranscripts: ["さっきの話だけど"],
    lastReaction: "neutral",
  });
  assert.equal(
    call?.context.questions.reaction?.instructions,
    VOICE_REACTION_CLASSIFICATION_INSTRUCTIONS,
  );
});

test("returns none for low confidence, unknown choices, and unsuccessful classifier results", async () => {
  const responses = [result("neutral", 0.69), result("agree", 1), result("empathetic", 1, "error")];
  const runtime: Pick<ModelRuntime, "classify"> = {
    async classify() {
      return responses.shift() as never;
    },
  };
  const selector = new PiVoiceReactionSelector(runtime, model);
  const input = { text: "話を聞いて", recentTranscripts: [] };
  const signal = new AbortController().signal;

  assert.equal(await selector.select(input, signal), "none");
  assert.equal(await selector.select(input, signal), "none");
  assert.equal(await selector.select(input, signal), "none");
});

test("returns none when already aborted or classifier throws", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let calls = 0;
  const runtime: Pick<ModelRuntime, "classify"> = {
    async classify() {
      calls++;
      throw new Error("classifier unavailable");
    },
  };
  const selector = new PiVoiceReactionSelector(runtime, model);

  assert.equal(
    await selector.select({ text: "質問", recentTranscripts: [] }, aborted.signal),
    "none",
  );
  assert.equal(calls, 0);
  assert.equal(
    await selector.select({ text: "質問", recentTranscripts: [] }, new AbortController().signal),
    "none",
  );
});
