import { describe, it, expect } from 'vitest';
import { buildSubmissionStateMap } from './parseGraderDocuments.js';

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
