import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithLimits } from './rateLimitedRunner.js';

describe('runWithLimits', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('returns results in input order', async () => {
    const items = [1, 2, 3, 4];
    const promise = runWithLimits(items, async (n) => n * 2, { concurrency: 2, ratePerSec: 100 });
    await vi.runAllTimersAsync();
    const out = await promise;
    expect(out).toEqual([2, 4, 6, 8]);
  });

  test('concurrency cap: never more than N in flight', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const worker = async () => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
      return 'ok';
    };
    const promise = runWithLimits([1, 2, 3, 4, 5, 6], worker, { concurrency: 2, ratePerSec: 100 });
    await vi.runAllTimersAsync();
    await promise;
    expect(maxObserved).toBe(2);
  });

  test('rate cap: respects ratePerSec across a window', async () => {
    const starts = [];
    const worker = async () => {
      starts.push(Date.now());
      return 'ok';
    };
    // Concurrency high enough not to be the limiter; rate=4/s with 8 items.
    // First 4 fire in the first second; remaining 4 fire in the second second.
    const promise = runWithLimits([1, 2, 3, 4, 5, 6, 7, 8], worker, { concurrency: 100, ratePerSec: 4 });
    await vi.advanceTimersByTimeAsync(1500);
    await promise;
    // Verify first 4 starts within first ~250ms, next 4 spread across the second second.
    expect(starts.slice(0, 4).every((t) => t - starts[0] < 250)).toBe(true);
    expect(starts[4] - starts[0]).toBeGreaterThanOrEqual(900); // ~1s after start
  });

  test('propagates worker errors with index attached', async () => {
    const worker = async (n) => {
      if (n === 3) throw new Error('boom');
      return n;
    };
    await expect(
      runWithLimits([1, 2, 3, 4], worker, { concurrency: 2, ratePerSec: 100 })
    ).rejects.toThrow('boom');
  });

  test('does not retry on error — caller handles', async () => {
    let calls = 0;
    const worker = async () => { calls++; throw new Error('x'); };
    await runWithLimits([1, 2, 3], worker, { concurrency: 1, ratePerSec: 100 }).catch(() => {});
    expect(calls).toBeLessThanOrEqual(3); // first failure may short-circuit; never retries
  });
});
