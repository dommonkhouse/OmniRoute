// Per-model default reasoning effort (#6879, "Ask 1"). Many models think by
// default with no client-visible way to turn it off (measured:
// gemini-flash-lite-latest burns ~277 reasoning tokens on a plain request with
// no reasoning params). ModelSpec.defaultReasoningEffort lets an operator
// configure a strip-by-default (or steer-by-default) value fleet-wide without
// patching every client.
//
// Semantics: applied ONLY when the request carries no reasoning field of any
// shape (`reasoning_effort`, `reasoning`, `thinking`) — an explicit client
// value, including one forwarded verbatim through a combo leg, always wins
// and this is a no-op. Models without a configured default are untouched
// (regression-safe). Wired at the OpenAI-format dispatch chokepoint in
// chatCore.ts, after model resolution, so the *upstream* model's default is
// used even when a combo/route substituted it.
import { getModelSpec } from "@/shared/constants/modelSpecs.ts";

/** True when `body` already expresses a reasoning-effort choice, in any known shape. */
function hasExplicitReasoningField(body: Record<string, unknown>): boolean {
  return (
    body.reasoning_effort !== undefined ||
    body.reasoning !== undefined ||
    body.thinking !== undefined
  );
}

/**
 * Pin a catalog-resolved `<base>-{effort}` variant onto an already-translated Claude
 * body as `output_config.effort`. Called per attempt by prepareUpstreamBody with the
 * same origin-model guard as applyDefaultReasoningEffort, so a replaced model drops
 * the tier. An explicit `output_config.effort` (client choice, translated) is never
 * overwritten.
 */
export function applyResolvedSuffixClaudeEffort<T extends Record<string, unknown>>(
  body: T,
  effort: string
): T {
  const outputConfig = (body.output_config ?? {}) as Record<string, unknown>;
  if (outputConfig.effort !== undefined) return body;
  return { ...body, output_config: { ...outputConfig, effort } };
}

/**
 * Pin a catalog-resolved `<base>-{effort}` variant onto an already-translated Gemini
 * body as `generationConfig.thinkingConfig.thinkingLevel`. The translator
 * default-injects a thinking level when the client sent none, so this replaces that
 * default; an explicit client level never reaches here (the caller skips when the
 * client body carries any reasoning shape). A numeric thinkingBudget is dropped —
 * the level makes it redundant per Google's 3.x migration guidance.
 */
export function applyResolvedSuffixGeminiLevel<T extends Record<string, unknown>>(
  body: T,
  level: string
): T {
  const generationConfig = (body.generationConfig ?? {}) as Record<string, unknown>;
  const thinkingConfig = {
    ...((generationConfig.thinkingConfig as Record<string, unknown> | undefined) ?? {}),
  };
  delete thinkingConfig.thinkingBudget;
  thinkingConfig.thinkingLevel = level;
  return {
    ...body,
    generationConfig: { ...generationConfig, thinkingConfig },
  };
}

/**
 * Inject a resolved reasoning effort as `reasoning_effort` when the request has no
 * reasoning field. Returns `body` unchanged (same reference) when there is nothing to
 * inject, so callers can chain it without extra guards.
 *
 * `suffixEffort` (#7694) is the tier a `<prefix>/<model>-{effort}` synced-model alias
 * resolved to (`src/sse/services/model.ts`'s `resolveSyncedModelIdAndEffort`) — an
 * explicit, request-time model selection, so it takes priority over both defaults
 * below when present.
 *
 * `syncedDefaultEffort` is the vendor-declared default captured at sync time
 * (`reasoning.default_effort`, e.g. OpenRouter `stealth/ox-alpha` declares `max`) —
 * see `detectDefaultThinkingEffort`. A model that only produces usable output with
 * an explicit effort gets the vendor default instead of an empty upstream response.
 * It is the LOWEST-priority default: an explicit client value wins, the suffix alias
 * wins, and a static `ModelSpec.defaultReasoningEffort` (operator-configured
 * strip-by-default, #6879) also wins over the vendor default.
 */
export function applyDefaultReasoningEffort<T extends Record<string, unknown>>(
  body: T,
  modelId: string,
  suffixEffort?: string | null,
  syncedDefaultEffort?: string | null
): T {
  if (!body || typeof body !== "object") return body;
  if (hasExplicitReasoningField(body)) return body;

  const defaultEffort =
    suffixEffort || getModelSpec(modelId)?.defaultReasoningEffort || syncedDefaultEffort;
  if (!defaultEffort) return body;

  return { ...body, reasoning_effort: defaultEffort };
}
