import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime } from './formatDate.js';

// A fixed local-time moment, so the test passes in any timezone.
const d = new Date(2026, 8, 6, 17, 40, 43); // 6 September 2026, 17:40:43

describe('formatDate', () => {
  it('is day-first (en-GB), never US month-first', () => {
    expect(formatDate(d)).toBe('06/09/2026');
  });

  it('accepts the ISO strings the API returns', () => {
    expect(formatDate(d.toISOString())).toBe('06/09/2026');
  });

  it('renders nothing for a missing or unparseable date', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('not a date')).toBe('');
  });
});

describe('formatDateTime', () => {
  it('is day-first with a 24-hour time and no seconds', () => {
    expect(formatDateTime(d)).toBe('06/09/2026, 17:40');
  });

  it('renders nothing for a missing date', () => {
    expect(formatDateTime(undefined)).toBe('');
  });
});
