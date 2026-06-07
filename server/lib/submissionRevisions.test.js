import { describe, test, expect } from 'vitest';
import { summarizeRevisions, groupRevisionsByUid } from './submissionRevisions.js';

describe('summarizeRevisions', () => {
  test('empty / non-array → null', () => {
    expect(summarizeRevisions([])).toBeNull();
    expect(summarizeRevisions(null)).toBeNull();
    expect(summarizeRevisions(undefined)).toBeNull();
  });

  test('picks the latest revision by revision_id and spreads it', () => {
    const r = summarizeRevisions([
      { revision_id: 1, uid: '701', created: 1000, late: 0, draft: 0 },
      { revision_id: 3, uid: '701', created: 3000, late: 1, draft: 0 },
      { revision_id: 2, uid: '701', created: 2000, late: 0, draft: 0 },
    ]);
    expect(r.revision_id).toBe(3);
    expect(r.late).toBe(1);
    expect(r.latestRevisionAt).toBe(3000);
  });

  test('latestRevisionAt ignores draft revisions', () => {
    const r = summarizeRevisions([
      { revision_id: 1, uid: '701', created: 1000, late: 0, draft: 0 },
      { revision_id: 2, uid: '701', created: 5000, late: 0, draft: 1 },
    ]);
    expect(r.revision_id).toBe(2);
    expect(r.draft).toBe(1);
    expect(r.latestRevisionAt).toBe(1000);
  });

  test('all-draft → latestRevisionAt is 0', () => {
    const r = summarizeRevisions([{ revision_id: 1, uid: '701', created: 1000, draft: 1 }]);
    expect(r.latestRevisionAt).toBe(0);
  });
});

describe('groupRevisionsByUid', () => {
  test('groups by string uid and summarizes each group', () => {
    const m = groupRevisionsByUid([
      { revision_id: 1, uid: 701, created: 1000, late: 0, draft: 0 },
      { revision_id: 2, uid: 701, created: 2000, late: 1, draft: 0 },
      { revision_id: 1, uid: '702', created: 500, late: 0, draft: 1 },
    ]);
    expect([...m.keys()].sort()).toEqual(['701', '702']);
    expect(m.get('701').latestRevisionAt).toBe(2000);
    expect(m.get('701').late).toBe(1);
    expect(m.get('702').draft).toBe(1);
    expect(m.get('702').latestRevisionAt).toBe(0);
  });

  test('empty / nullish → empty map', () => {
    expect(groupRevisionsByUid([]).size).toBe(0);
    expect(groupRevisionsByUid(null).size).toBe(0);
  });
});
