import type { ModelAvailabilityResult } from "@omniroute/open-sse/services/combo/types.ts";

/** Preserve an account timer without leaking credentials or weakening caller policy. */
export function getComboCredentialAvailability(
  credentials: object | null | undefined,
  now = Date.now()
): ModelAvailabilityResult {
  if (!credentials || ("waitingForCapacity" in credentials && credentials.waitingForCapacity)) {
    return false;
  }
  if (!("allRateLimited" in credentials) || !credentials.allRateLimited) return true;

  // Auth marks quota-shaped exhaustion explicitly: this must reach the combo
  // layer as quota so a protected fallback can treat it as quota exhaustion,
  // while plain rate-limit cooldowns stay non-quota.
  if ("quotaExhausted" in credentials && credentials.quotaExhausted === true) {
    const quotaResetAt =
      "retryAfter" in credentials && typeof credentials.retryAfter === "string"
        ? Date.parse(credentials.retryAfter)
        : NaN;
    const quotaRetryAfterMs = quotaResetAt - now;
    return {
      available: false,
      reason: "quota_exhausted",
      retryAfterMs: Number.isFinite(quotaRetryAfterMs) && quotaRetryAfterMs > 0 ? quotaRetryAfterMs : 0,
    };
  }

  // Auth returns an ISO deadline, not Retry-After header seconds. Missing,
  // malformed or expired hints must not fabricate a new cooldown deadline.
  const resetAt =
    "retryAfter" in credentials && typeof credentials.retryAfter === "string"
      ? Date.parse(credentials.retryAfter)
      : NaN;
  const retryAfterMs = resetAt - now;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return false;
  return { available: false, reason: "connection_cooldown", retryAfterMs };
}
