// Runs `worker(item)` for each item with two limits:
//   - concurrency: max N workers running concurrently
//   - ratePerSec: max R start events per rolling 1s window (token bucket)
//
// Results are returned in input order. The first worker error rejects the
// promise; other in-flight work completes but no further items start. The
// runner does not retry — callers handle that policy.
export async function runWithLimits(items, worker, { concurrency, ratePerSec }) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be >= 1');
  }
  if (!Number.isFinite(ratePerSec) || ratePerSec < 1) {
    throw new RangeError('ratePerSec must be >= 1');
  }

  const results = new Array(items.length);
  let nextIndex = 0;
  let inFlight = 0;
  let firstError = null;
  const starts = []; // timestamps of recent starts (last 1s)
  let resolveAll, rejectAll;
  const all = new Promise((res, rej) => { resolveAll = res; rejectAll = rej; });

  async function maybeStartMore() {
    if (firstError) {
      if (inFlight === 0) rejectAll(firstError);
      return;
    }
    while (inFlight < concurrency && nextIndex < items.length) {
      const now = Date.now();
      while (starts.length && now - starts[0] >= 1000) starts.shift();
      if (starts.length >= ratePerSec) {
        const waitMs = 1000 - (now - starts[0]) + 1;
        setTimeout(maybeStartMore, waitMs);
        return;
      }
      const i = nextIndex++;
      starts.push(now);
      inFlight++;
      Promise.resolve()
        .then(() => worker(items[i]))
        .then((val) => { results[i] = val; })
        .catch((err) => { if (!firstError) firstError = err; })
        .finally(() => {
          inFlight--;
          if (nextIndex >= items.length && inFlight === 0) {
            if (firstError) rejectAll(firstError);
            else resolveAll(results);
          } else {
            maybeStartMore();
          }
        });
    }
    if (nextIndex >= items.length && inFlight === 0) {
      if (firstError) rejectAll(firstError);
      else resolveAll(results);
    }
  }

  if (items.length === 0) return [];
  maybeStartMore();
  return all;
}
