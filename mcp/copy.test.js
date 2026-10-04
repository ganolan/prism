import { describe, test, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { findEmDashOffenders } from '../server/testing/copyGuard.js';

// Teacher rule (AGENTS.md "Frontend Conventions"): no em dashes in UI copy,
// they take too much inline room. Use a hyphen, comma or colon instead.
// PrisMCP's tool descriptions and messages are agent-facing rather than
// teacher-facing, but the rule is kept consistent across surfaces.
const ROOT = path.dirname(fileURLToPath(import.meta.url));

describe('no em dashes in tool copy (AGENTS.md Frontend Conventions)', () => {
  test('mcp/ has no em dash outside comments', () => {
    const offenders = findEmDashOffenders(ROOT);
    expect(offenders, `Em dashes found (replace with a hyphen, comma or colon):\n${offenders.join('\n')}`).toEqual([]);
  });
});
