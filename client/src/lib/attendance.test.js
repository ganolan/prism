import { describe, it, expect } from 'vitest';
import { initialChoices, markAllPresent, counts, canSave, marksToSend, otherCodes, codeLabel, isDirty } from './attendance.js';

// #39. A lesson as GET /api/attendance/:courseId answers it.
const CODES = [{ code: '', description: 'Present' }, { code: 'A', description: 'Absence' }, { code: 'I', description: 'Illness' }, { code: 'T', description: 'Tardy' }];
const st = (id, code, extra = {}) => ({ ps_student_id: id, code, office: false, markable: true, ...extra });
const lesson = (students, taken = false) => ({ lesson: true, taken, codes: CODES, students, fingerprint: 'f' });

describe('attendance rules', () => {
  it('before attendance is taken a blank mark is not marked; office marks and teacher codes show', () => {
    const l = lesson([st('1', ''), st('2', 'I', { office: true }), st('3', 'T'), st('4', '', { markable: false })]);
    expect(initialChoices(l)).toEqual({ 1: null, 2: 'I', 3: 'T', 4: null });
  });
  it('once taken, a blank mark is Present', () => {
    expect(initialChoices(lesson([st('1', '')], true))).toEqual({ 1: '' });
  });
  it('Mark all present fills only the students not marked, never an office mark', () => {
    const l = lesson([st('1', ''), st('2', 'I', { office: true }), st('3', '')]);
    const c = markAllPresent({ 1: null, 2: 'I', 3: 'A' }, l);
    expect(c).toEqual({ 1: '', 2: 'I', 3: 'A' });
  });
  it('counts, and Save waits until every student is marked', () => {
    const l = lesson([st('1', ''), st('2', 'I', { office: true }), st('3', '')]);
    expect(counts({ 1: null, 2: 'I', 3: 'T' }, l)).toEqual({ present: 0, tardy: 1, absent: 0, other: 1, unmarked: 1 });
    expect(canSave({ 1: null, 2: 'I', 3: 'T' }, l)).toBe(false);
    expect(canSave({ 1: '', 2: 'I', 3: 'T' }, l)).toBe(true);
  });
  it('a taken lesson saves only when something changed', () => {
    const l = lesson([st('1', ''), st('2', 'A')], true);
    expect(canSave(initialChoices(l), l)).toBe(false);
    expect(isDirty({ 1: 'T', 2: 'A' }, l)).toBe(true);
    expect(canSave({ 1: 'T', 2: 'A' }, l)).toBe(true);
  });
  it('sends every editable student\'s choice, never an office mark', () => {
    const l = lesson([st('1', ''), st('2', 'I', { office: true }), st('3', '')]);
    expect(marksToSend({ 1: '', 2: 'I', 3: 'A' }, l)).toEqual({ 1: '', 3: 'A' });
  });
  it('the Other menu leaves out Present, Tardy and Absent; labels name the code', () => {
    expect(otherCodes(lesson([])).map((c) => c.code)).toEqual(['I']);
    expect(codeLabel('I', lesson([]))).toBe('Illness (I)');
    expect(codeLabel('', lesson([]))).toBe('Present');
  });
});
