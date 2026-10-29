import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api.js', () => ({ getAttendance: vi.fn(), getAttendanceDays: vi.fn(), getClassTimes: vi.fn(), saveAttendance: vi.fn() }));
import { getAttendance, getAttendanceDays, getClassTimes, saveAttendance } from '../../services/api.js';
import AttendanceTab, { dateWords } from './AttendanceTab.jsx';

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

const MEETINGS = [{ date: '2026-10-27', start: '08:35', end: '09:45' }, { date: '2026-10-29', start: '08:35', end: '09:45' }, { date: '2026-10-30', start: '10:00', end: '11:10' }];
// Thu 29 Oct 2026, 10:00 in Hong Kong (the same date in UTC, so CI agrees). Only Date is faked.
const at = (iso) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)); };
beforeEach(() => {
  at('2026-10-29T02:00:00Z');
  vi.mocked(getClassTimes).mockResolvedValue({ meetings: MEETINGS });
  vi.mocked(getAttendanceDays).mockResolvedValue({ days: MEETINGS.map((m) => ({ ...m, taken: m.date === '2026-10-27' ? true : m.date === '2026-10-29' ? false : null })) });
  vi.mocked(getAttendance).mockResolvedValue(structuredClone(LESSON));
});
afterEach(() => vi.useRealTimers());

describe('AttendanceTab (#39)', () => {
  it('opens the latest lesson; Present, Tardy and Absent on each row; the office mark locked with its comment', async () => {
    renderTab();
    await screen.findByText('Student One');
    expect(getAttendance).toHaveBeenCalledWith('580', '2026-10-29');
    expect(screen.getByText('Not taken yet')).toBeInTheDocument();
    // Other on the far left, then Tardy, Absent, and Present on the far right (Graham, 29 Oct 2026).
    expect(within(row('Student One')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Other ▾', 'Tardy', 'Absent', 'Present']);
    expect(screen.getByText('Today (Thu 29/10), 08:35 to 09:45')).toBeInTheDocument();
    // The counts and Save come after the list.
    const list = screen.getByRole('list');
    const saveBtn = screen.getByRole('button', { name: 'Save to PowerSchool' });
    expect(list.compareDocumentPosition(saveBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('Other opens a menu of the school\'s other codes; the chosen code shows on the segment, ticked in the menu', async () => {
    renderTab();
    await screen.findByText('Student One');
    const other = within(row('Student One')).getByRole('button', { name: 'Other code for Student One' });
    expect(other).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(other);
    const menu = screen.getByRole('menu', { name: 'Other codes for Student One' });
    expect(within(menu).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['IIllness']); // Present, Tardy, Absent are on the strip
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Illness/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    const chosen = within(row('Student One')).getByRole('button', { name: 'Other code for Student One: I, Illness' });
    expect(chosen).toHaveTextContent('I: Illness');
    expect(screen.getByText(/Other 2/)).toBeInTheDocument();
    fireEvent.click(chosen);
    expect(screen.getByRole('menuitemradio', { name: /Illness/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    // Choosing Present on the strip clears the Other segment.
    fireEvent.click(within(row('Student One')).getByRole('button', { name: 'Present' }));
    expect(within(row('Student One')).getByRole('button', { name: 'Other code for Student One' })).toHaveTextContent('Other');
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

  it('the calendar opens from its icon: lesson days with their status, today marked, a later lesson not clickable', async () => {
    renderTab();
    await screen.findByText('Student One');
    expect(screen.queryByLabelText('Lessons')).toBeNull(); // hidden until asked for
    fireEvent.click(screen.getByRole('button', { name: 'Choose another lesson' }));
    const cal = screen.getByLabelText('Lessons');
    expect(within(cal).getByText('October 2026')).toBeInTheDocument();
    expect(within(cal).getByRole('button', { name: 'Tue 27/10, 08:35, attendance taken' })).toBeInTheDocument();
    const todayBtn = within(cal).getByRole('button', { name: 'Today (Thu 29/10), 08:35, not taken yet' });
    expect(todayBtn).toHaveAttribute('aria-pressed', 'true');
    expect(todayBtn).toHaveClass('att-cal__day--today');
    expect(within(cal).getByText('Today')).toBeInTheDocument(); // the key
    expect(within(cal).queryByRole('button', { name: /Fri 30\/10/ })).toBeNull();
    fireEvent.click(within(cal).getByRole('button', { name: /Tue 27\/10/ }));
    await waitFor(() => expect(getAttendance).toHaveBeenLastCalledWith('580', '2026-10-27'));
    expect(screen.queryByLabelText('Lessons')).toBeNull(); // picking a lesson closes it
    expect(await screen.findByText('Tue 27/10, 08:35 to 09:45')).toBeInTheDocument();
  });

  it('date words: Today and Yesterday first, the date in brackets; other days plain', () => {
    expect(dateWords('2026-10-29', '2026-10-29')).toBe('Today (Thu 29/10)');
    expect(dateWords('2026-10-28', '2026-10-29')).toBe('Yesterday (Wed 28/10)');
    expect(dateWords('2026-10-27', '2026-10-29')).toBe('Tue 27/10');
    expect(dateWords('2026-10-31', '2026-11-01')).toBe('Yesterday (Sat 31/10)');
  });

  it('on a day without a lesson it opens the last lesson, saying so and naming the next', async () => {
    at('2026-10-28T02:00:00Z'); // Wed 28 Oct: no lesson
    renderTab();
    await screen.findByText('Student One');
    expect(getAttendance).toHaveBeenCalledWith('580', '2026-10-27');
    expect(screen.getByText(/This class has no lesson today \(Wed 28\/10\)\. Showing the last lesson, Tue 27\/10\. Next lesson: Thu 29\/10\./)).toBeInTheDocument();
  });

  it('a save marks the day taken on the calendar', async () => {
    vi.mocked(saveAttendance).mockResolvedValue({ lesson: { ...structuredClone(LESSON), taken: true }, changed: 0 });
    renderTab();
    await screen.findByText('Student One');
    fireEvent.click(screen.getByRole('button', { name: 'Mark all 2 present' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to PowerSchool' }));
    await screen.findByText(/Saved to PowerSchool/);
    fireEvent.click(screen.getByRole('button', { name: 'Choose another lesson' }));
    expect(screen.getByRole('button', { name: 'Today (Thu 29/10), 08:35, attendance taken' })).toBeInTheDocument();
  });
});
