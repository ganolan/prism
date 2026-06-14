import { describe, test, expect } from 'vitest';
import { retryAsync } from './retryAsync.js';

// A sleep spy that records its calls and never actually waits.
function fakeSleep() {
  const calls = [];
  const sleep = (ms) => { calls.push(ms); return Promise.resolve(); };
  sleep.calls = calls;
  return sleep;
}

describe('retryAsync', () => {
  test('returns the value on first success without retrying or sleeping', async () => {
    let calls = 0;
    const sleep = fakeSleep();
    const result = await retryAsync(() => { calls++; return 'ok'; }, { attempts: 2, backoffMs: 750, sleep });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(sleep.calls).toEqual([]);
  });

  test('retries when the result is null and returns the eventual value', async () => {
    let calls = 0;
    const sleep = fakeSleep();
    const result = await retryAsync(() => { calls++; return calls < 2 ? null : 'recovered'; }, { attempts: 2, backoffMs: 750, sleep });
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
    expect(sleep.calls).toEqual([750]);
  });

  test('returns null after exhausting attempts when every call fails', async () => {
    let calls = 0;
    const sleep = fakeSleep();
    const result = await retryAsync(() => { calls++; return null; }, { attempts: 2, backoffMs: 750, sleep });
    expect(result).toBeNull();
    expect(calls).toBe(2);
    expect(sleep.calls).toEqual([750]); // one wait between the two attempts, none after the last
  });

  test('treats a thrown error as a failed attempt and retries', async () => {
    let calls = 0;
    const sleep = fakeSleep();
    const result = await retryAsync(() => { calls++; if (calls < 2) throw new Error('boom'); return 'after-throw'; }, { attempts: 2, backoffMs: 0, sleep });
    expect(result).toBe('after-throw');
    expect(calls).toBe(2);
  });

  test('a custom shouldRetry predicate controls what counts as a failure', async () => {
    let calls = 0;
    const sleep = fakeSleep();
    const result = await retryAsync(() => { calls++; return calls; }, {
      attempts: 3, backoffMs: 0, sleep, shouldRetry: (r) => r < 3,
    });
    expect(result).toBe(3);
    expect(calls).toBe(3);
  });
});
