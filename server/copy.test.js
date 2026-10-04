import { describe, test, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { findEmDashOffenders } from './testing/copyGuard.js';

// Teacher rule (AGENTS.md "Frontend Conventions"): no em dashes in UI copy,
// they take too much inline room. Use a hyphen, comma or colon instead. On
// the server that means error messages, TriageError messages and route
// `error:` strings (anything a client can render) — not code comments, and
// not console.* diagnostics, which a teacher never sees.
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// console.warn/console.log lines, never returned to a client or surfaced in
// the UI, so exempt from the rule. Matched by (file, substring) so this list
// can't accidentally exempt an unrelated future em dash in the same file.
const ALLOWLIST = [
  { file: 'server/routes/mastery.js', text: 'but Prism has a grade — not writing blind' }, // console.warn
  { file: 'server/routes/mastery.js', text: 'but Prism has a grade — batch not sent' }, // console.warn
  { file: 'server/services/statusLinePublisher.js', text: 'but Prism has a grade — not writing blind' }, // console.warn
  { file: 'server/services/sync.js', text: ' — ' }, // console.log-only `period` template: ` — ${c.grading_period}`
];

describe('no em dashes in UI copy (AGENTS.md Frontend Conventions)', () => {
  test('server/ has no em dash outside comments and console-only logs', () => {
    const offenders = findEmDashOffenders(ROOT, { allowlist: ALLOWLIST });
    expect(offenders, `Em dashes found (replace with a hyphen, comma or colon):\n${offenders.join('\n')}`).toEqual([]);
  });
});
