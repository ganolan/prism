import { describe, it, expect } from 'vitest';
import { buildSubmissionStateMap, buildSubmissionDetailMap } from './parseGraderDocuments.js';

// Expected epoch (seconds) for a wall-clock, computed runtime-local — mirrors
// the parser, so these assertions hold on any CI timezone (#125 decision).
const localEpoch = (y, monthIndex, d, h, min) =>
  Math.floor(new Date(y, monthIndex, d, h, min).getTime() / 1000);

const submitted = { data: [{ id: 11862763, revisionCreated: true }] };
const inProgress = { data: [
  { id: 132465441, revisionCreated: false }, // never opened → not_started
  { id: 117424434, revisionCreated: true },  // opened → in_progress
] };

describe('buildSubmissionStateMap', () => {
  it('maps submitted-documents entries to "submitted"', () => {
    const m = buildSubmissionStateMap(submitted, { data: [] });
    expect(m.get('11862763')).toBe('submitted');
  });

  it('splits in-progress by revisionCreated', () => {
    const m = buildSubmissionStateMap({ data: [] }, inProgress);
    expect(m.get('132465441')).toBe('not_started');
    expect(m.get('117424434')).toBe('in_progress');
  });

  it('submitted wins if a uid somehow appears in both lists', () => {
    const m = buildSubmissionStateMap({ data: [{ id: 5, revisionCreated: true }] }, { data: [{ id: 5, revisionCreated: false }] });
    expect(m.get('5')).toBe('submitted');
  });

  it('returns an empty map for empty/missing payloads', () => {
    expect(buildSubmissionStateMap(null, null).size).toBe(0);
    expect(buildSubmissionStateMap({}, {}).size).toBe(0);
  });

  it('keys are string uids', () => {
    const m = buildSubmissionStateMap({ data: [{ id: 42, revisionCreated: true }] }, { data: [] });
    expect([...m.keys()]).toEqual(['42']);
  });
});

describe('buildSubmissionDetailMap', () => {
  it('parses a well-formed submissionDate to a runtime-local epoch', () => {
    const m = buildSubmissionDetailMap({
      data: [{ id: 55454030, submissionTiming: 1, submissionDate: 'Tuesday, June 9, 2026 at 3:27 pm' }],
    });
    expect(m.get('55454030').submittedAt).toBe(localEpoch(2026, 5, 9, 15, 27));
  });

  it('decodes submissionTiming: 2 → late, 0/1 → on-time', () => {
    const m = buildSubmissionDetailMap({ data: [
      { id: 1, submissionTiming: 2, submissionDate: 'Monday, June 15, 2026 at 4:18 am' }, // late
      { id: 2, submissionTiming: 1, submissionDate: 'Tuesday, June 9, 2026 at 3:27 pm' }, // on-time
      { id: 3, submissionTiming: 0, submissionDate: '' },                                  // none
    ] });
    expect(m.get('1').late).toBe(1);
    expect(m.get('2').late).toBe(0);
    expect(m.get('3').late).toBe(0);
  });

  it('handles 12am (midnight) and 12pm (noon)', () => {
    const m = buildSubmissionDetailMap({ data: [
      { id: 1, submissionTiming: 1, submissionDate: 'Monday, June 15, 2026 at 12:50 am' }, // 00:50
      { id: 2, submissionTiming: 1, submissionDate: 'Monday, June 15, 2026 at 12:10 pm' }, // 12:10
    ] });
    expect(m.get('1').submittedAt).toBe(localEpoch(2026, 5, 15, 0, 50));
    expect(m.get('2').submittedAt).toBe(localEpoch(2026, 5, 15, 12, 10));
  });

  it('guards an empty or unparseable submissionDate to null (late still decoded)', () => {
    const m = buildSubmissionDetailMap({ data: [
      { id: 1, submissionTiming: 2, submissionDate: '' },
      { id: 2, submissionTiming: 2, submissionDate: 'not a date' },
      { id: 3, submissionTiming: 1 }, // missing entirely
    ] });
    expect(m.get('1')).toEqual({ submittedAt: null, late: 1 });
    expect(m.get('2')).toEqual({ submittedAt: null, late: 1 });
    expect(m.get('3')).toEqual({ submittedAt: null, late: 0 });
  });

  it('keys by string uid and returns an empty map for missing payload', () => {
    const m = buildSubmissionDetailMap({ data: [{ id: 42, submissionTiming: 1, submissionDate: 'Friday, May 22, 2026 at 2:29 pm' }] });
    expect([...m.keys()]).toEqual(['42']);
    expect(buildSubmissionDetailMap(null).size).toBe(0);
  });
});
