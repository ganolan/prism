import { describe, test, expect } from 'vitest';
import { isTeacherOf } from './sectionRole.js';

describe('isTeacherOf', () => {
  test('admin 1 (number or string) is the teacher\'s course; admin 0 is a section the teacher sat in', () => {
    expect(isTeacherOf({ id: '1', admin: 1 })).toBe(true);
    expect(isTeacherOf({ id: '1', admin: '1' })).toBe(true);
    expect(isTeacherOf({ id: '2', admin: 0 })).toBe(false);
    expect(isTeacherOf({ id: '2', admin: '0' })).toBe(false);
  });
  test('a row without the field is kept', () => {
    expect(isTeacherOf({ id: '3' })).toBe(true);
  });
});
