import { CONTEXT_WINDOW_EXCEEDED_ERROR_CODE, type StructuredError } from "@/core/contracts";
import { ProviderRequestError } from "@/core/lm/http";

// Prompt-too-long, however a provider spells it: llama.cpp's typed error
// (which also carries both token counts), OpenAI's code, and the messages
// servers use without a type ("request (N tokens) exceeds the available
// context size", LM Studio's "context the overflows", "maximum context
// length is N"). A message match only counts on a 400/413 or in a stream.
const CONTEXT_OVERFLOW_MESSAGE_PATTERN =
  /exceeds? the (available|maximum|max)? ?context|maximum context length|larger than the max(imum)? context|context the overflows|context (length|window|size) (exceeded|is too small)/iu;

/**
 * A model provider's error as a context overflow
 * (`CONTEXT_WINDOW_EXCEEDED_ERROR_CODE`) when it is one, else unchanged. The
 * language-model adapters apply it to what their server reported, over HTTP
 * or inside a stream; the shared HTTP client classifies nothing, since other
 * kinds of provider (ComfyUI) use it too.
 *
 * `remedy` is the provider's own way to a larger window ("start llama-server
 * with a larger -c"), kept in `details.remedy` for the message the agent loop
 * shows when compacting did not help.
 */
export function classifyContextOverflow(error: StructuredError, remedy?: string): StructuredError {
  if (error.code === CONTEXT_WINDOW_EXCEEDED_ERROR_CODE) {
    return error;
  }
  const body = error.details.response;
  const reported = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : {};
  const typed = reported.type === "exceed_context_size_error" || reported.code === "context_length_exceeded";
  const status = error.details.status;
  const messageMatches =
    (error.code === "provider_stream_error" || status === 400 || status === 413) &&
    CONTEXT_OVERFLOW_MESSAGE_PATTERN.test(error.message);
  if (!typed && !messageMatches) {
    return error;
  }
  return {
    ...error,
    code: CONTEXT_WINDOW_EXCEEDED_ERROR_CODE,
    details: {
      ...error.details,
      ...(typeof reported.n_ctx === "number" ? { contextWindowTokens: reported.n_ctx } : {}),
      ...(typeof reported.n_prompt_tokens === "number" ? { promptTokens: reported.n_prompt_tokens } : {}),
      ...(remedy ? { remedy } : {})
    },
    // A prompt that did not fit will not fit on a retry either; the loop
    // compacts instead.
    retriable: false
  };
}

/** A thrown provider error with its structured error classified, for rethrowing; anything else unchanged. */
export function classifyThrownContextOverflow(error: unknown, remedy?: string): unknown {
  if (!(error instanceof ProviderRequestError)) {
    return error;
  }
  const classified = classifyContextOverflow(error.structuredError, remedy);
  return classified === error.structuredError ? error : new ProviderRequestError(classified);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
