import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FlagsPanel from './FlagsPanel.jsx';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ getGradeFlags: vi.fn(), setGradeFlag: vi.fn() }));

// #174: rows as getTriage returns them (server/services/flagRows.js).
const row = (over = {}) => ({
  kind: 'flag', flag: 6, exception: 6, studentId: 7, studentUid: 'u7', studentName: 'Sam Lee', firstName: 'Sam',
  studentEmail: null, courseId: 3, courseName: 'AP CSP', blockNumber: '2', assignmentId: 30, schoologyAssignmentId: '900',
  title: 'Essay', dueDate: '2026-10-05', aligned: true, score: null, flagSeenOn: '2026-10-12', submittedAfter: false,
  advice: 'Grade the work, or mark it Missing if it is too late to count.', semesterEnd: '2026-12-18',
  day: 5, limit: 50, tone: 'green', approx: false, ...over,
});

function renderPanel(rows, props = {}) {
  const onChange = vi.fn();
  render(<MemoryRouter><FlagsPanel rows={rows} showCourse={false} scope="all" onChange={onChange} {...props} /></MemoryRouter>);
  return { onChange };
}
const panel = () => screen.getByLabelText('Flags');

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('FlagsPanel', () => {
  it('a row: the student link to their card, the task, the flag symbol, the advice and the day count', () => {
    renderPanel([row()]);
    const r = screen.getByRole('link', { name: 'Sam Lee' }).closest('.triage-row');
    expect(screen.getByRole('link', { name: 'Sam Lee' })).toHaveAttribute('href', '/course/3/assessment/900?student=7');
    expect(r).toHaveTextContent('Essay');
    expect(r).toHaveTextContent('Grade the work, or mark it Missing if it is too late to count.');
    expect(within(r).getByRole('img', { name: '4 school days' })).toBeInTheDocument();
    expect(r.querySelector('.triage-row__text .flag-symbol--late')).not.toBeNull();
    expect(within(r).getByRole('button', { name: /Flag set in Schoology: Late/ })).toHaveClass('flags-pill--compact');
  });

  it('a row submitted after the flag is tagged', () => {
    renderPanel([row({ flag: 3, exception: 3, submittedAfter: true, advice: 'Clear the flag and grade the work.' })]);
    expect(panel()).toHaveTextContent('Submitted after the flag');
  });

  it('a saved grade row shows its advice, no flag symbol in its text, and the control with no flag', () => {
    renderPanel([row({ kind: 'saved_grade', flag: 0, exception: 0, advice: 'Restore the saved grade, or publish a new one.' })]);
    const r = screen.getByRole('link', { name: 'Sam Lee' }).closest('.triage-row');
    expect(r).toHaveTextContent('Restore the saved grade, or publish a new one.');
    expect(r.querySelector('.triage-row__text .flag-symbol')).toBeNull();
    expect(within(r).getByRole('button', { name: 'Flag this work in Schoology' })).toBeInTheDocument();
  });

  it('the subheading names the semester end when the rows share one', () => {
    renderPanel([row(), row({ studentId: 8, studentName: 'Ana Ruiz' })]);
    expect(panel()).toHaveTextContent('school days since flagged, semester ends 18/12/2026');
  });

  it('the subheading leaves the end out when the rows have different ends or none', () => {
    renderPanel([row(), row({ studentId: 8, studentName: 'Ana Ruiz', semesterEnd: null })]);
    expect(panel()).toHaveTextContent('school days since flagged');
    expect(panel()).not.toHaveTextContent('semester ends');
  });

  it('a badge counts the urgent (red) rows', () => {
    renderPanel([row({ tone: 'red' }), row({ studentId: 8, studentName: 'Ana Ruiz', tone: 'amber' })]);
    expect(panel()).toHaveTextContent('1 urgent');
  });

  it('hidden on a fresh load with no rows', () => {
    renderPanel([]);
    expect(screen.queryByLabelText('Flags')).toBeNull();
  });

  it('once it has shown rows, an emptied list stays with one line', () => {
    const onChange = vi.fn();
    const { rerender } = render(<MemoryRouter><FlagsPanel rows={[row()]} showCourse={false} scope="all" onChange={onChange} /></MemoryRouter>);
    rerender(<MemoryRouter><FlagsPanel rows={[]} showCourse={false} scope="all" onChange={onChange} /></MemoryRouter>);
    expect(panel()).toHaveTextContent('No flags waiting on you.');
  });

  it('course chips on the all-courses view', () => {
    renderPanel([row()], { showCourse: true });
    expect(panel()).toHaveTextContent('AP CSP');
  });

  it('a flag written from the row reloads the rows', async () => {
    api.getGradeFlags.mockResolvedValue({
      exception: 6, score: null, comment: '', commentStatus: 1, graded: false, gradeText: null, savedGrade: null, openRecords: [], hasDraft: false,
    });
    api.setGradeFlag.mockResolvedValue({ exception: 3, saved: false, withdrawn: [], line: null, restored: null });
    const { onChange } = renderPanel([row()]);
    fireEvent.click(screen.getByRole('button', { name: /Flag set in Schoology: Late/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Missing/ }));
    const confirm = await screen.findByRole('button', { name: 'Mark missing' });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.setGradeFlag).toHaveBeenCalled());
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });
});
