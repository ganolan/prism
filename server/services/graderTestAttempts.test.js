import { describe, test, expect, vi } from 'vitest';
import { fetchSectionTestAttempts } from './graderTestAttempts.js';

// A fake Playwright context: page.evaluate is handed the in-page fetch args and
// returns `payload` (or throws), so no browser is launched.
function fakeContext({ url = 'https://schoology.hkis.edu.hk/home', payload = null, evaluateError = null } = {}) {
  const page = {
    goto: vi.fn().mockResolvedValue(),
    url: () => url,
    evaluate: vi.fn(async () => { if (evaluateError) throw evaluateError; return payload; }),
    close: vi.fn().mockResolvedValue(),
  };
  return { page, context: { newPage: vi.fn().mockResolvedValue(page) } };
}

const PAYLOAD = { body: { grades: { 701: { T1: { uid: '701', grade_item_nid: 'T1', submission: 'assessment', has_assessment: true } } } } };

describe('fetchSectionTestAttempts', () => {
  test('one grader_grade_data GET for the section (period "all"), with a fetch timeout; parsed result', async () => {
    const { context, page } = fakeContext({ payload: PAYLOAD });
    const m = await fetchSectionTestAttempts(context, '8458134140', ['701', '702'], ['T1', 'T2']);
    expect(m.get('701').get('T1')).toEqual({ took: true, notAssigned: false });
    const [, args] = page.evaluate.mock.calls[0];
    expect(args.u).toBe('https://schoology.hkis.edu.hk/iapi/grades/grader_grade_data/8458134140/all?uids=701,702&grade_item_nids=T1,T2');
    expect(args.timeoutMs).toBeGreaterThan(0);
    expect(page.close).toHaveBeenCalled();
  });

  test('null when the session is not logged in (never fetches)', async () => {
    const { context, page } = fakeContext({ url: 'https://login.microsoftonline.com/x' });
    expect(await fetchSectionTestAttempts(context, 's', ['701'], ['T1'])).toBeNull();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  test('null on a failed/timed-out fetch or a bad payload; never throws', async () => {
    expect(await fetchSectionTestAttempts(fakeContext({ evaluateError: new Error('TimeoutError') }).context, 's', ['701'], ['T1'])).toBeNull();
    expect(await fetchSectionTestAttempts(fakeContext({ payload: null }).context, 's', ['701'], ['T1'])).toBeNull();
    expect(await fetchSectionTestAttempts(fakeContext({ payload: { body: [] } }).context, 's', ['701'], ['T1'])).toBeNull();
  });

  test('null without students or tests (nothing to ask)', async () => {
    const { context } = fakeContext({ payload: PAYLOAD });
    expect(await fetchSectionTestAttempts(context, 's', [], ['T1'])).toBeNull();
    expect(await fetchSectionTestAttempts(context, 's', ['701'], [])).toBeNull();
    expect(context.newPage).not.toHaveBeenCalled();
  });
});
