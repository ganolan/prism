/**
 * retryAsync.js
 *
 * Tiny generic retry wrapper. Calls `fn` up to `attempts` times, retrying when
 * the result satisfies `shouldRetry` (default: a null/undefined result) or `fn`
 * throws. Waits `backoffMs` between attempts via the injectable `sleep` (so
 * tests can pass `backoffMs: 0` or a spy and never actually wait). Returns the
 * last result; a throw on the final attempt yields null.
 *
 * Used by the sync's lti_submission document fetch — which returns null on a
 * transient browser-session hiccup rather than throwing — so a single retry
 * recovers the common all-or-nothing per-assignment failure (see
 * docs/superpowers/specs/2026-06-14-lti-submission-status-display-design.md).
 */

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retryAsync(fn, { attempts = 2, backoffMs = 0, sleep = defaultSleep, shouldRetry = (r) => r == null } = {}) {
  let result = null;
  for (let i = 0; i < attempts; i++) {
    try {
      result = await fn();
    } catch {
      result = null;
    }
    if (!shouldRetry(result)) return result;
    if (i < attempts - 1) await sleep(backoffMs);
  }
  return result;
}
