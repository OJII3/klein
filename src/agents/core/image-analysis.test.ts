import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyImageAnalysisFailure,
  ImageAnalysisError,
  toImageAnalysisFailure,
} from "./image-analysis";

test("classifies rate limit responses", () => {
  assert.deepEqual(classifyImageAnalysisFailure('429: {"type":"server_error"}'), {
    reason: "rate_limited",
    status: 429,
    retryable: true,
  });
});

test("classifies billing responses from a nested provider body", () => {
  assert.deepEqual(
    classifyImageAnalysisFailure(
      '{"error":{"message":"{\\"error\\":{\\"code\\":402}}","code":402,"status":"Payment Required"}}',
    ),
    { reason: "http_error", status: 402, retryable: false },
  );
});

test("classifies server errors as retryable", () => {
  assert.deepEqual(classifyImageAnalysisFailure("HTTP 503 upstream unavailable"), {
    reason: "http_error",
    status: 503,
    retryable: true,
  });
});

test("classifies request timeouts as retryable", () => {
  assert.deepEqual(classifyImageAnalysisFailure("(408) request timeout"), {
    reason: "http_error",
    status: 408,
    retryable: true,
  });
});

test("falls back to unknown without a status", () => {
  assert.deepEqual(classifyImageAnalysisFailure("socket hang up"), {
    reason: "unknown",
    retryable: true,
  });
});

test("keeps the failure of an ImageAnalysisError", () => {
  const failure = { reason: "empty_result" as const, retryable: true };

  assert.equal(toImageAnalysisFailure(new ImageAnalysisError(failure)), failure);
});
