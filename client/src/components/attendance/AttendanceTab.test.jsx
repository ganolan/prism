import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api.js', () => ({ getAttendance: vi.fn(), getClassTimes: vi.fn(), saveAttendance: vi.fn() }));
import { getAttendance, getClassTimes, saveAttendance } from '../../services/api.js';
import AttendanceTab from './AttendanceTab.jsx';

// #39. Masked fixtures: no real names.
const CODES = [{ code: '', description: 'Present' }, { code: 'A', description: 'Absence' }, { code: 'I', description: 'Illness' }, { code: 'T', description: 'Tardy' }];
const LESSON = {
  date: '2026-10-29', lesson: true, taken: false, codes: CODES, fingerprint: 'f1',
  students: [
    { ps_student_id: '11', student_id: 1, name: 'Student One', code: '', comment: null, office: false, markable: true },
    { ps_student_id: '12', student_id: 2, name: 'Student Two', code: 'I', comment: 'Called in sick', office: true, markable: true },
    { ps_student_id: '13', student_id: null, name: 'Student Three', code: '', comment: null, office: false, markable: true },
  ],
};
const renderTab = () => render(<MemoryRouter><AttendanceTab courseId="580" /></MemoryRouter>);
const row = (name) => screen.getByText(name).closest('li');

beforeEach(() => {
  vi.mocked(getClassTimes).mockResolvedValue({ meetings: [{ date: '2026-10-27', start: '08:35', end: '09:45' }, { date: '2026-10-29', start: '08:35', end: '09:45' }] });
  vi.mocked(getAttendance).mockResolvedValue(structuredClone(LESSON));
});

describe('AttendanceTab (#39)', () => {
  it('opens the latest lesson; Present, Tardy and Absent on each row; the office mark locked with its comment', async () => {
    renderTab();
    await screen.findByText('Student One');
    expect(getAttendance).toHaveBeenCalledWith('580', '2026-10-29');
    expect(screen.getByText('Not taken yet')).toBeInTheDocument();
    expect(within(row('Student One')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Present', 'Tardy', 'Absent']);
    expect(within(row('Student Two')).queryByRole('button')).toBeNull();
    expect(within(row('Student Two')).getByText('Office: Illness (I)')).toBeInTheDocument();
    expect(within(row('Student Two')).getByText('Called in sick')).toBeInTheDocument();
    expect(screen.getByText(/Not marked 2/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save to PowerSchool' })).toBeDisabled();
  });

  it('the fill button names how many it marks; it fills only the rest; Save sends every choice and shows the read-back', async () => {
    vi.mocked(saveAttendance).mockResolvedValue({ lesson: { ...structuredClone(LESSON), taken: true, students: LESSON.students.map((s) => (s.ps_student_id === '13' ? { ...s, code: 'T' } : s)) }, changed: 1 });
    renderTab();
    await screen.findByText('Student One');
    expect(screen.getByRole('button', { name: 'Mark all 2 present' })).toBeInTheDocument();
    fireEvent.click(within(row('Student Three')).getByRole('button', { name: 'Tardy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark the remaining 1 present' }));
    expect(screen.queryByRole('button', { name: /present$/ })).toBeNull(); // none left to fill
    expect(within(row('Student One')).getByRole('button', { name: 'Present' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(row('Student Three')).getByRole('button', { name: 'Tardy' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save to PowerSchool' }));
    await waitFor(() => expect(saveAttendance).toHaveBeenCalledWith('580', { date: '2026-10-29', marks: { 11: '', 13: 'T' }, fingerprint: 'f1' }));
    expect(await screen.findByText(/Saved to PowerSchool at .* Every mark read back as sent\./)).toBeInTheDocument();
    expect(screen.getByText('Taken in PowerSchool')).toBeInTheDocument();
  });

  it('an Other code from the school\'s list', async () => {
    renderTab();
    await screen.findByText('Student One');
    fireEvent.change(within(row('Student One')).getByRole('combobox', { name: 'Other code for Student One' }), { target: { value: 'I' } });
    expect(screen.getByText(/Other 2/)).toBeInTheDocument();
  });

  it('a refused save shows why and the lesson as PowerSchool now holds it', async () => {
    const fresh = { ...structuredClone(LESSON), fingerprint: 'f2', students: LESSON.students.map((s) => (s.ps_student_id === '11' ? { ...s, code: 'A', office: true } : s)) };
    vi.mocked(saveAttendance).mockRejectedValue(Object.assign(new Error('Attendance changed in PowerSchool since this lesson was opened.'), { code: 'CHANGED', lesson: fresh }));
    renderTab();
    await screen.findByText('Student One');
    fireEvent.click(screen.getByRole('button', { name: 'Mark all 2 present' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to PowerSchool' }));
    expect(await screen.findByText(/Attendance changed in PowerSchool/)).toBeInTheDocument();
    expect(within(row('Student One')).getByText('Office: Absence (A)')).toBeInTheDocument();
  });

  it('another lesson from the list', async () => {
    renderTab();
    await screen.findByText('Student One');
    fireEvent.change(screen.getByRole('combobox', { name: 'Lesson' }), { target: { value: '2026-10-27' } });
    await waitFor(() => expect(getAttendance).toHaveBeenLastCalledWith('580', '2026-10-27'));
  });
});
