import { describe, test, expect } from 'vitest';
import { preferredFirstName, studentFullName } from './studentNames.js';

// Client mirror of server/services/studentNames.js — the single source of truth
// for display-name precedence: teacher override > Schoology preferred > legal
// first name. Keeping the client copy in lockstep means every page (and the
// PrisMCP roster) names a student the same way.
describe('preferredFirstName', () => {
  test('prefers the teacher override above all else', () => {
    expect(preferredFirstName({
      preferred_name_teacher: 'Lexi', preferred_name: 'Ada', first_name: 'Adelaide',
    })).toBe('Lexi');
  });

  test('falls back to the Schoology preferred name when no teacher override', () => {
    expect(preferredFirstName({
      preferred_name_teacher: null, preferred_name: 'Ada', first_name: 'Adelaide',
    })).toBe('Ada');
  });

  test('falls back to the legal first name when neither preferred name is set', () => {
    expect(preferredFirstName({
      preferred_name_teacher: null, preferred_name: null, first_name: 'Adelaide',
    })).toBe('Adelaide');
  });

  test('treats an empty-string preferred field as unset', () => {
    expect(preferredFirstName({
      preferred_name_teacher: '', preferred_name: '', first_name: 'Adelaide',
    })).toBe('Adelaide');
  });
});

describe('studentFullName', () => {
  test('joins the resolved first name with the last name', () => {
    expect(studentFullName({
      preferred_name_teacher: 'Lexi', preferred_name: 'Ada', first_name: 'Adelaide', last_name: 'Lovelace',
    })).toBe('Lexi Lovelace');
  });

  test('omits a missing last name without a trailing space', () => {
    expect(studentFullName({ first_name: 'Ada', last_name: null })).toBe('Ada');
  });
});
