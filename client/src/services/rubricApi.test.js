import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRubricForAssignment, attachRubric, uploadRubricCsv, renameRubric } from './api.js';

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
});

describe('rubric api', () => {
  it('getRubricForAssignment GETs the assignment rubric', async () => {
    await getRubricForAssignment('800');
    expect(fetch).toHaveBeenCalledWith('/api/rubrics/assignment/800', expect.any(Object));
  });
  it('attachRubric POSTs ids as JSON', async () => {
    await attachRubric({ rubricId: 1, courseId: 4, assignmentId: '800' });
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('/api/rubrics/attach');
    expect(JSON.parse(opts.body)).toEqual({ rubricId: 1, courseId: 4, assignmentId: '800' });
  });
  it('renameRubric PATCHes the new name as JSON', async () => {
    await renameRubric(7, 'New name');
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('/api/rubrics/7');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ name: 'New name' });
  });
  it('uploadRubricCsv POSTs multipart without a JSON content-type', async () => {
    await uploadRubricCsv('MAD', new Blob(['x']));
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('/api/rubrics/upload');
    expect(opts.body).toBeInstanceOf(FormData);
    expect(opts.headers?.['Content-Type']).toBeUndefined();
  });
});
