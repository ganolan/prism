// get_support_summary (#163): the PowerSchool Student Support Summary for the agent,
// read on demand through the same service as the student page.
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../server/db/index.js';
import { getSupportSummaryTool } from './handlers.js';
import { SupportSummaryError } from '../server/services/psSupportSummary.js';

let id;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM student_ps_alerts; DELETE FROM enrolments; DELETE FROM students;');
  id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, email) VALUES ('u1', 'Ana', 'Lee', 'ana@example.org')`).run().lastInsertRowid;
});

describe('getSupportSummaryTool', () => {
  test('resolves the student, reads the summary, and labels it for the teacher only', async () => {
    const read = vi.fn(async () => ({ rows: [{ category: 'Support Notes', description: '25% extra time' }], readAt: '2026-10-18T10:00:00.000Z' }));
    const r = await getSupportSummaryTool(getDb(), { student: 'ana@example.org' }, { read, features: { powerschool_alerts: true } });
    expect(read).toHaveBeenCalledWith(getDb(), id);
    expect(r).toMatchObject({
      student_id: id,
      rows: [{ category: 'Support Notes', description: '25% extra time' }],
      read_at: '2026-10-18T10:00:00.000Z',
    });
    expect(r.note).toMatch(/teacher only/i);
    expect(r.note).toMatch(/verbatim/i);
  });

  test('a refusal comes back as its reason', async () => {
    const read = vi.fn(async () => { throw new SupportSummaryError('NO_ALERT', 'PowerSchool shows no Student Support Summary for this student'); });
    await expect(getSupportSummaryTool(getDb(), { student: id }, { read, features: { powerschool_alerts: true } }))
      .rejects.toThrow(/no Student Support Summary/);
  });

  test('refused while powerschool_alerts is off, with no read', async () => {
    const read = vi.fn();
    await expect(getSupportSummaryTool(getDb(), { student: id }, { read, features: { powerschool_alerts: false } }))
      .rejects.toThrow(/PowerSchool alerts are off/);
    expect(read).not.toHaveBeenCalled();
  });
});
