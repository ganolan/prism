import { describe, test, expect } from 'vitest';
import { preferredFirstName, studentFullName } from './studentNames.js';

// The app-wide display precedence: a teacher-set override beats Schoology's
// synced preferred name, which beats the legal first name. These helpers are
// the single source of truth so the MCP roster names students the same way the
// UI does (server/routes/tools.js + the client pages all follow this order).
describe('preferredFirstName', () => {
  test('prefers the teacher override above all else', () => {
    expect(preferredFirstName({
      preferred_name_teacher: 'Lexi',
      preferred_name: 'Ada',
      first_name: 'Adelaide',
    })).toBe('Lexi');
  });

  test('falls back to the Schoology preferred name when no teacher override', () => {
    expect(preferredFirstName({
      preferred_name_teacher: null,
      preferred_name: 'Ada',
      first_name: 'Adelaide',
    })).toBe('Ada');
  });

  test('falls back to the legal first name when neither preferred name is set', () => {
    expect(preferredFirstName({
      preferred_name_teacher: null,
      preferred_name: null,
      first_name: 'Adelaide',
    })).toBe('Adelaide');
  });

  test('treats an empty-string preferred field as unset', () => {
    expect(preferredFirstName({
      preferred_name_teacher: '',
      preferred_name: '',
      first_name: 'Adelaide',
    })).toBe('Adelaide');
  });
});

describe('studentFullName', () => {
  test('joins the resolved first name with the last name', () => {
    expect(studentFullName({
      preferred_name_teacher: 'Lexi',
      preferred_name: 'Ada',
      first_name: 'Adelaide',
      last_name: 'Lovelace',
    })).toBe('Lexi Lovelace');
  });

  test('omits a missing last name without a trailing space', () => {
    expect(studentFullName({ first_name: 'Ada', last_name: null })).toBe('Ada');
  });
});
