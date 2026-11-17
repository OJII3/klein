import type { ImageAnalysisFailure } from "@agents/core/image-analysis";

export const IMAGE_ANALYSIS_FAILURE_CUSTOM_TYPE = "klein-image-analysis-error";

export function formatImageAnalysisFailureMessage(failure: ImageAnalysisFailure): string {
  const details = [
    `reason: ${failure.reason}`,
    failure.status === undefined ? undefined : `http_status: ${failure.status}`,
    `retryable: ${failure.retryable}`,
  ]
    .filter((detail): detail is string => detail !== undefined)
    .join(", ");

  const guidance = guidanceFor(failure);

  return (
    `<image-analysis-error>\n` +
    `The attached image(s) could not be analyzed (${details}).\n` +
    `You cannot see the image contents. Do not guess what the image shows.\n` +
    `${guidance}\n` +
    `</image-analysis-error>`
  );
}

function guidanceFor(failure: ImageAnalysisFailure): string {
  if (failure.reason === "rate_limited") {
    return "This is a temporary rate limit. If the image matters for your reply, tell the user it could not be read and ask them to send it again later.";
  }
  if (failure.retryable) {
    return "If the image matters for your reply, tell the user it could not be read and ask them to send it again.";
  }
  return "Do not ask the user to resend the image; the same failure is likely to repeat. Answer from the text if possible, or say image reading is currently unavailable.";
}
