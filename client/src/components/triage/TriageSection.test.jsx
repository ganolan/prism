import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TriageSection from './TriageSection.jsx';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getTriage: vi.fn(),
  recordReferral: vi.fn(),
  getReferrals: vi.fn(),
  undoReferral: vi.fn(),
  recordExtension: vi.fn(),
  undoExtension: vi.fn(),
  getExtensions: vi.fn(),
  setMakeUpIgnored: vi.fn(),
  getResubmissions: vi.fn(),
  updateResubmission: vi.fn(),
  reviewResubmission: vi.fn(),
  undoResubmission: vi.fn(),
}));

const SETTINGS = {
  referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDay: 2, makeUpRedDay: 4,
};
const PAYLOAD = {
  settings: SETTINGS, includeFormative: false, historyCount: 2, lastSyncAt: '2026-10-01 07:42:00', makeUpsUnchecked: 0,
  calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
  lateWork: [
    { kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, day: 10, tone: 'red', approx: false },
    { kind: 'submitted_late', studentId: 2, studentName: 'Ethan Wong', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-09-21', daysLate: 10, day: 11, submittedDay: 11, submittedOn: '2026-10-05', tone: 'red', approx: false },
    { kind: 'outstanding', studentId: 3, studentName: 'Aiden Li', courseId: 6, courseName: 'AP CSP', blockNumber: '7', assignmentId: 10, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-14', daysLate: 2, day: 3, tone: 'green', approx: false, extension: { id: 4, lessons: 3, until: '2026-10-15', note: null } },
  ],
  feedbackOwed: [
    { assignmentId: 4, schoologyAssignmentId: 'a4', courseId: 6, courseName: 'AP CSP', blockNumber: '7', title: 'Model Card', dueDate: '2026-09-14', aligned: true, owed: 18, submittedTotal: 22, oldestWaitDays: 11, day: 12, tone: 'red', approx: false },
  ],
  makeUps: [
    { studentId: 7, studentName: 'Noah Park', courseId: 8, courseName: 'AP CSP', blockNumber: '3', assignmentId: 20, schoologyAssignmentId: 'q20', title: 'Unit 1 test', dueDate: '2026-10-13', daysSince: 3, day: 4, tone: 'red', approx: false, extension: null },
    { studentId: 8, studentName: 'Zoe Tan', courseId: 5, courseName: 'AP CSP', assignmentId: 21, schoologyAssignmentId: 'q21', title: 'Unit 2 quiz', dueDate: '2026-10-15', daysSince: 0, day: 1, tone: 'green', approx: false, extension: { id: 9, lessons: 2, until: '2026-10-20', note: 'sits Tue' } },
  ],
};
const latePanel = async () => screen.findByLabelText('Late work');
const makeUpPanel = async () => screen.findByLabelText('Make-up tests');
const rowOf = (el) => el.closest('.triage-row');
const referButtons = () => screen.getAllByRole('button', { name: 'Refer' });

function renderSection(props = {}) {
  return render(<MemoryRouter><TriageSection {...props} /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  api.getTriage.mockResolvedValue(PAYLOAD);
  api.recordReferral.mockResolvedValue({ id: 1 });
  api.recordExtension.mockResolvedValue({ id: 2 });
  api.getReferrals.mockResolvedValue([]);
  api.getExtensions.mockResolvedValue([]);
  api.setMakeUpIgnored.mockResolvedValue({ assignmentId: 20, title: 'Unit 1 test', ignored: true });
  api.getResubmissions.mockResolvedValue([]);
  api.reviewResubmission.mockResolvedValue({});
  api.updateResubmission.mockResolvedValue({});
  api.undoResubmission.mockResolvedValue({});
});

describe('TriageSection', () => {
  it('renders both panels with counts, tags and course chips (all-courses view)', async () => {
    renderSection();
    expect(await screen.findByText('Maya Chen')).toBeInTheDocument();
    expect(screen.getByText('2 to refer')).toBeInTheDocument();
    expect(screen.getByText('submitted day 11')).toBeInTheDocument();
    expect(screen.getByTitle('18 of 22 ungraded')).toHaveTextContent('18/22');
    expect(screen.getAllByText('AP CSP').length).toBeGreaterThan(0);
    expect(screen.getAllByText('[BK 7] AP CSP')).toHaveLength(2); // one late row + one feedback row
    expect(screen.getByText('ext +3 → 15/10/2026')).toBeInTheDocument();
    expect(screen.getByText(/Referred \/ extended \(2\)/)).toBeInTheDocument();
    expect(screen.getByText('due date = day 1 · refer after day 8')).toBeInTheDocument();
  });

  it('Referred / extended opens the history inside the Late work panel, right below the link; the link and Close both toggle it', async () => {
    renderSection();
    const panel = await latePanel();
    const link = within(panel).getByText(/Referred \/ extended \(2\)/);
    expect(within(panel).queryByLabelText('Referral history')).not.toBeInTheDocument();
    fireEvent.click(link);
    const history = within(panel).getByLabelText('Referral history');
    expect(history.previousElementSibling).toBe(link.closest('button')); // sits immediately below the link
    fireEvent.click(within(history).getByText('Close'));
    expect(within(panel).queryByLabelText('Referral history')).not.toBeInTheDocument();
    fireEvent.click(link); // re-opens
    expect(within(panel).getByLabelText('Referral history')).toBeInTheDocument();
    fireEvent.click(link); // the link itself toggles it closed too
    expect(within(panel).queryByLabelText('Referral history')).not.toBeInTheDocument();
  });

  it('renders as the triage rail (a complementary landmark); `hidden` hides it but keeps it mounted', async () => {
    const { rerender } = renderSection();
    const rail = await screen.findByRole('complementary', { name: 'Triage' });
    expect(rail).toHaveClass('triage-rail');
    expect(within(rail).getByLabelText('Late work')).toBeInTheDocument();
    rerender(<MemoryRouter><TriageSection hidden /></MemoryRouter>);
    expect(screen.queryByRole('complementary', { name: 'Triage' })).not.toBeInTheDocument();
    expect(document.querySelector('.triage-rail')).toHaveAttribute('hidden');
    expect(api.getTriage).toHaveBeenCalledTimes(1);
  });

  it('hides course chips on a course page and passes courseId', async () => {
    renderSection({ courseId: 5 });
    await screen.findByText('Maya Chen');
    expect(api.getTriage).toHaveBeenCalledWith({ courseId: 5, includeFormative: undefined });
    expect(screen.queryByText('AP CSP')).not.toBeInTheDocument();
    expect(screen.queryByText('[BK 7] AP CSP')).not.toBeInTheDocument();
  });

  it('Mark referred (the inline Refer button) posts and reloads', async () => {
    renderSection();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Refer' }))[0]);
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 1, assignmentId: 9, action: 'referred', note: undefined }));
    expect(api.getTriage).toHaveBeenCalledTimes(2);
  });

  it('every row offers Extend without expanding; Refer / Mark referred only on red rows; no Exempt', async () => {
    renderSection();
    const panel = await latePanel();
    expect(within(panel).getAllByRole('button', { name: 'Refer' })).toHaveLength(2); // inline Refer, red rows
    expect(within(panel).getAllByText('Extend')).toHaveLength(3); // visible on every row, no expand needed
    expect(screen.queryByText('Exempt')).not.toBeInTheDocument();
  });

  it('Extend posts N lessons (default 3) and a note, then reloads', async () => {
    renderSection();
    const maya = rowOf(within(await latePanel()).getByText('Maya Chen'));
    fireEvent.click(within(maya).getByText('Extend')); // Maya: no extension yet
    const lessons = screen.getByLabelText('Extension (lessons)');
    expect(lessons).toHaveValue(3);
    expect(lessons).toHaveAttribute('max', '60');
    expect(screen.getByLabelText('Extension note')).toHaveValue('');
    fireEvent.click(screen.getByLabelText('Increase'));
    fireEvent.change(screen.getByLabelText('Extension note'), { target: { value: 'sick week' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.recordExtension).toHaveBeenCalledWith({ studentId: 1, assignmentId: 9, lessons: 4, note: 'sick week' }));
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText('Extension (lessons)')).not.toBeInTheDocument();
  });

  it('re-extending pre-fills the editor with the current extension', async () => {
    const lateWork = PAYLOAD.lateWork.map((r) => (r.studentId === 3 ? { ...r, extension: { id: 4, lessons: 5, until: '2026-10-21', note: 'trip' } } : r));
    api.getTriage.mockResolvedValue({ ...PAYLOAD, lateWork });
    renderSection();
    const aiden = rowOf(within(await latePanel()).getByText('Aiden Li'));
    fireEvent.click(within(aiden).getByText('Extend'));
    expect(screen.getByLabelText('Extension (lessons)')).toHaveValue(5);
    expect(screen.getByLabelText('Extension note')).toHaveValue('trip');
  });

  it('Extend → Cancel closes the editor without posting', async () => {
    renderSection();
    const maya = rowOf(within(await latePanel()).getByText('Maya Chen'));
    fireEvent.click(within(maya).getByText('Extend'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByLabelText('Extension (lessons)')).not.toBeInTheDocument();
    expect(within(maya).getByText('Extend')).toBeInTheDocument();
    expect(api.recordExtension).not.toHaveBeenCalled();
  });

  it('Show formative refetches with includeFormative true', async () => {
    renderSection();
    fireEvent.click(await screen.findByLabelText('Show formative'));
    await waitFor(() => expect(api.getTriage).toHaveBeenLastCalledWith({ courseId: null, includeFormative: true }));
  });

  it('hands the payload to onLoaded', async () => {
    const onLoaded = vi.fn();
    renderSection({ onLoaded });
    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith(PAYLOAD));
  });

  it('renders nothing when the API yields no payload', async () => {
    api.getTriage.mockResolvedValue(undefined);
    const { container } = renderSection();
    await waitFor(() => expect(api.getTriage).toHaveBeenCalled());
    expect(container.querySelector('.triage')).toBeNull();
  });

  it('history rows: name and title truncate, so each carries its full text as a title', async () => {
    api.getReferrals.mockResolvedValue([
      { id: 3, action: 'referred', daysLate: 9, day: 10, createdAt: '2026-10-01 07:42:00', studentName: 'Maya Chen', courseName: 'AP CSP', blockNumber: '7', title: 'CP2 - A very long assignment title', note: null },
    ]);
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('Maya Chen')).toHaveAttribute('title', 'Maya Chen');
    expect(within(history).getByText('CP2 - A very long assignment title')).toHaveAttribute('title', 'CP2 - A very long assignment title');
    expect(within(history).getByText('[BK 7] AP CSP')).toHaveAttribute('title', '[BK 7] AP CSP');
  });

  it('history rows show the block; a failed undo shows the error inline', async () => {
    api.getReferrals.mockResolvedValue([
      { id: 3, action: 'referred', daysLate: 9, day: 10, createdAt: '2026-10-01 07:42:00', studentName: 'Maya Chen', courseName: 'AP CSP', blockNumber: '7', title: 'CP2', note: null },
    ]);
    api.undoReferral.mockRejectedValue(new Error('Server unreachable'));
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('[BK 7] AP CSP')).toBeInTheDocument();
    fireEvent.click(within(history).getByText('Undo'));
    const alert = await within(history).findByText(/Server unreachable/);
    expect(alert.closest('.alert')).toHaveClass('alert-warning');
    expect(within(history).getByText('Maya Chen')).toBeInTheDocument(); // the row stays
  });

  it('history lists referrals and extensions; Undo on an extension calls undoExtension', async () => {
    api.getReferrals.mockResolvedValue([
      { id: 3, action: 'referred', daysLate: 9, day: 10, createdAt: '2026-10-01 07:42:00', studentName: 'Maya Chen', courseName: 'AP CSP', title: 'CP2', note: null },
    ]);
    api.getExtensions.mockResolvedValue([
      { id: 7, lessons: 3, until: '2026-10-15', createdAt: '2026-10-02 01:00:00', studentName: 'Aiden Li', courseName: 'AP CSP', title: 'CP2', note: 'sick' },
    ]);
    api.undoExtension.mockResolvedValue({ deleted: true });
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('Extended +3 → 15/10/2026')).toBeInTheDocument();
    expect(within(history).getByText('Referred · day 10')).toBeInTheDocument();
    // Newest first: the extension (02/10) above the referral (01/10).
    expect(within(history).getAllByText(/Aiden Li|Maya Chen/).map((el) => el.textContent)).toEqual(['Aiden Li', 'Maya Chen']);
    fireEvent.click(within(history).getAllByText('Undo')[0]);
    await waitFor(() => expect(api.undoExtension).toHaveBeenCalledWith(7));
    expect(api.undoReferral).not.toHaveBeenCalled();
  });

  it('history: a failed half shows its own inline error and the other half still lists', async () => {
    api.getReferrals.mockRejectedValue(new Error('Server unreachable'));
    api.getExtensions.mockResolvedValue([
      { id: 7, lessons: 3, until: '2026-10-15', createdAt: '2026-09-01 01:00:00', updatedAt: '2026-10-03 01:00:00', studentName: 'Aiden Li', courseName: 'AP CSP', title: 'CP2', note: null },
    ]);
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('Extended +3 → 15/10/2026')).toBeInTheDocument();
    expect(within(history).getByText('03/10/2026')).toBeInTheDocument(); // re-extended date, not the first grant
    expect(within(history).getByText(/Couldn't load referrals: Server unreachable/).closest('.alert')).toHaveClass('alert-warning');
    expect(within(history).queryByText(/Couldn't load extensions/)).not.toBeInTheDocument();
  });

  it('history: failed extensions still list the referrals', async () => {
    api.getReferrals.mockResolvedValue([
      { id: 3, action: 'referred', daysLate: 9, day: 10, createdAt: '2026-10-01 07:42:00', studentName: 'Maya Chen', courseName: 'AP CSP', title: 'CP2', note: null },
    ]);
    api.getExtensions.mockRejectedValue(new Error('boom'));
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('Referred · day 10')).toBeInTheDocument();
    expect(within(history).getByText(/Couldn't load extensions: boom/)).toBeInTheDocument();
  });

  it('an open history reloads after Mark referred', async () => {
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    await waitFor(() => expect(api.getReferrals).toHaveBeenCalledTimes(1));
    fireEvent.click(referButtons()[0]);
    await waitFor(() => expect(api.getReferrals).toHaveBeenCalledTimes(2));
  });
});

describe('TriageSection — compact rows', () => {
  const textOf = (row) => row.querySelector('.triage-row__text');

  it('late-work row: 28px ring, then name (link) + tag / course / title, each one line with a full-text title', async () => {
    renderSection();
    const panel = await latePanel();
    const row = rowOf(within(panel).getByText('Aiden Li'));
    expect(row.firstElementChild).toHaveAttribute('aria-label', 'day 3, limit day 8');
    expect(row.firstElementChild.querySelector('svg')).toHaveAttribute('width', '28');
    const lines = [...textOf(row).children];
    expect(lines.map((el) => el.className)).toEqual(['triage-row__line', 'triage-row__course', 'triage-row__task']);
    const name = within(lines[0]).getByRole('link', { name: 'Aiden Li' });
    expect(name).toHaveAttribute('href', '/student/3');
    expect(name).toHaveAttribute('title', 'Aiden Li');
    expect(lines[0]).toHaveTextContent('Aiden Liext +3 → 15/10/2026'); // the tag sits beside the name
    expect(lines[1]).toHaveTextContent('[BK 7] AP CSP');
    expect(lines[1]).toHaveAttribute('title', '[BK 7] AP CSP');
    expect(lines[2]).toHaveTextContent(/^CP2$/);
    expect(lines[2]).toHaveAttribute('title', 'CP2');
  });

  it('red late-work row: the submitted-day tag beside the name; an inline primary Refer button', async () => {
    renderSection();
    const row = rowOf(within(await latePanel()).getByText('Ethan Wong'));
    expect(within(row).getByRole('img', { name: 'day 11, limit day 8' })).toBeInTheDocument();
    expect(row.querySelector('.triage-row__line')).toHaveTextContent('Ethan Wongsubmitted day 11');
    expect(row.querySelector('.triage-row__task')).toHaveTextContent(/^CP2$/);
    const refer = within(row.querySelector('.triage-row__actions')).getByRole('button', { name: 'Refer' });
    expect(refer).toHaveAttribute('title', 'Mark referred');
    expect(refer).toHaveClass('primary', 'btn-sm');
  });

  it('a green row has no Refer button', async () => {
    renderSection();
    const row = rowOf(within(await latePanel()).getByText('Aiden Li'));
    expect(within(row).queryByRole('button', { name: 'Refer' })).not.toBeInTheDocument();
  });

  it('a non-red row stacks days-left above Extend in the action column, no expand needed', async () => {
    renderSection();
    const row = rowOf(within(await latePanel()).getByText('Aiden Li'));
    expect(row.querySelector('.triage-row__more')).toBeNull(); // no editor until Extend is clicked
    const actions = row.querySelector('.triage-row__actions');
    expect([...actions.children].map((el) => el.textContent)).toEqual(['5 left', 'Extend']);
    const extend = within(actions).getByText('Extend');
    expect(extend).toHaveClass('secondary', 'btn-sm');
    expect(within(actions).queryByRole('button', { name: 'Refer' })).not.toBeInTheDocument(); // green row
    fireEvent.click(extend);
    const more = row.querySelector('.triage-row__more');
    expect(more).not.toBeNull();
    expect(more.previousElementSibling).toBe(actions);
    expect(within(actions).getByText('Extend')).toBeInTheDocument(); // the stack stays, unlike the old expanded area
  });

  it('a red row stacks Refer above Extend; Refer is inline only, never repeated', async () => {
    renderSection();
    const row = rowOf(within(await latePanel()).getByText('Maya Chen'));
    const actions = row.querySelector('.triage-row__actions');
    expect([...actions.children].map((el) => el.textContent)).toEqual(['Refer', 'Extend']);
    fireEvent.click(within(actions).getByText('Extend'));
    const more = row.querySelector('.triage-row__more');
    expect(within(more).queryByRole('button', { name: 'Refer' })).not.toBeInTheDocument();
    expect(within(row).getAllByRole('button', { name: 'Refer' })).toHaveLength(1);
    expect(within(more).queryByText(/left|last day/)).not.toBeInTheDocument();
  });

  it('day 8 of 8 (the last allowed day) says "last day", not "0 left"; no Mark referred yet', async () => {
    api.getTriage.mockResolvedValue({
      ...PAYLOAD,
      lateWork: [{ ...PAYLOAD.lateWork[2], daysLate: 7, day: 8, tone: 'amber' }],
    });
    renderSection();
    const row = rowOf(within(await latePanel()).getByText('Aiden Li'));
    expect(within(row).getByRole('img', { name: 'day 8, limit day 8' })).toHaveTextContent('8');
    expect(within(row.querySelector('.triage-row__actions')).getByText('last day')).toBeInTheDocument();
    expect(within(row).queryByText(/left/)).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Refer' })).not.toBeInTheDocument();
  });

  it('short subtitles in the rail', async () => {
    renderSection();
    expect(within(await makeUpPanel()).getByText('test day = day 1 · sit by day 3')).toBeInTheDocument();
    expect(within(await latePanel()).getByText('due date = day 1 · refer after day 8')).toBeInTheDocument();
    const panel = await screen.findByLabelText('Feedback owed');
    expect(within(panel).getByText('day 1 = due date (or a late submission) · overdue after day 10')).toBeInTheDocument();
  });

  it('feedback row: ring, then title (link, full-text title) / course, then the count right-aligned as "X/Y"', async () => {
    renderSection();
    const panel = await screen.findByLabelText('Feedback owed');
    const row = rowOf(within(panel).getByText('Model Card'));
    expect(row.firstElementChild).toHaveAttribute('aria-label', 'day 12, limit day 10');
    const lines = [...textOf(row).children];
    expect(lines.map((el) => el.className)).toEqual(['triage-row__line', 'triage-row__course']);
    const title = within(lines[0]).getByRole('link', { name: 'Model Card' });
    expect(title).toHaveAttribute('href', '/course/6/assessment/a4');
    expect(title).toHaveAttribute('title', 'Model Card');
    expect(lines[1]).toHaveTextContent('[BK 7] AP CSP');
    expect(lines[1]).not.toHaveTextContent(/ungraded/);
    const count = within(row.querySelector('.triage-row__actions')).getByTitle('18 of 22 ungraded');
    expect(count).toHaveTextContent(/^18\/22$/);
    expect(row.lastElementChild).toBe(row.querySelector('.triage-row__actions'));
    expect(within(row).queryByRole('button')).not.toBeInTheDocument(); // feedback rows have no row actions
  });

  it('feedback: a formative row tags F beside the title', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, feedbackOwed: [{ ...PAYLOAD.feedbackOwed[0], aligned: false }] });
    renderSection();
    const row = rowOf(within(await screen.findByLabelText('Feedback owed')).getByText('Model Card'));
    expect(row.querySelector('.triage-row__line')).toHaveTextContent('Model CardF');
  });

  it('make-up row: ring, three lines; the action column stacks Extend above Ignore this test', async () => {
    renderSection();
    const row = rowOf(within(await makeUpPanel()).getByText('Noah Park'));
    expect(row.firstElementChild).toHaveAttribute('aria-label', 'day 4, limit day 4');
    expect([...textOf(row).children].map((el) => el.textContent)).toEqual(['Noah Park', '[BK 3] AP CSP', 'Unit 1 test']);
    const actions = row.querySelector('.triage-row__actions');
    expect([...actions.children].map((el) => el.textContent)).toEqual(['Extend', 'Ignore this test']);
    expect(within(actions).getByText('Extend')).toHaveClass('secondary');
    expect(within(actions).getByText('Ignore this test')).toHaveClass('secondary');
  });

  it('make-up row: the extension tag sits beside the name', async () => {
    renderSection();
    const row = rowOf(within(await makeUpPanel()).getByText('Zoe Tan'));
    expect(row.querySelector('.triage-row__line')).toHaveTextContent('Zoe Tanext +2 → 20/10/2026');
  });

  it('the Extend editor opens below the row without expanding, and without removing the action buttons', async () => {
    renderSection();
    const row = rowOf(within(await latePanel()).getByText('Maya Chen'));
    const actions = row.querySelector('.triage-row__actions');
    fireEvent.click(within(actions).getByText('Extend'));
    const more = row.querySelector('.triage-row__more');
    expect(within(more).getByLabelText('Extension (lessons)')).toBeInTheDocument();
    expect(within(actions).getByText('Extend')).toBeInTheDocument(); // the stack isn't replaced
    expect(within(actions).getAllByRole('button', { name: 'Refer' })).toHaveLength(1);
  });

  it('the Ignore confirm opens below the row too, closing an open Extend editor on the same row', async () => {
    renderSection();
    const row = rowOf(within(await makeUpPanel()).getByText('Noah Park'));
    const actions = row.querySelector('.triage-row__actions');
    fireEvent.click(within(actions).getByText('Extend'));
    fireEvent.click(within(actions).getByText('Ignore this test'));
    const more = row.querySelector('.triage-row__more');
    expect(within(more).getByText('Ignore Unit 1 test for all students?')).toBeInTheDocument();
    expect(within(more).queryByLabelText('Extension (lessons)')).not.toBeInTheDocument();
  });

  it('no course line on a course page (two-line rows)', async () => {
    renderSection({ courseId: 5 });
    const row = rowOf(within(await latePanel()).getByText('Maya Chen'));
    expect(row.querySelector('.triage-row__course')).toBeNull();
    expect(row.querySelector('.triage-row__text').children).toHaveLength(2);
  });
});

describe('TriageSection — 5 rows, then "All N" in the header', () => {
  const lateRows = (n) => Array.from({ length: n }, (_, i) => ({
    ...PAYLOAD.lateWork[0], studentId: 100 + i, studentName: `Student ${i + 1}`, tone: i < 6 ? 'red' : 'green',
  }));
  const names = (panel) => within(panel).getAllByRole('link', { name: /^Student \d+$/ }).map((a) => a.textContent);

  it('shows the 5 most urgent rows (server order) with "All N ▾" in the panel header; the badge counts the full list', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, lateWork: lateRows(7) });
    renderSection();
    const panel = await latePanel();
    expect(names(panel)).toEqual(['Student 1', 'Student 2', 'Student 3', 'Student 4', 'Student 5']);
    const toggle = within(panel.querySelector('.triage-panel__head')).getByRole('button', { name: /^All 7/ });
    expect(toggle).toHaveTextContent('All 7 ▾');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel).getByText('6 to refer')).toBeInTheDocument();
  });

  it('toggling shows every row and switches to "Fewer ▴"; again collapses', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, lateWork: lateRows(7) });
    renderSection();
    const panel = await latePanel();
    fireEvent.click(within(panel).getByRole('button', { name: /^All 7/ }));
    expect(names(panel)).toHaveLength(7);
    const fewer = within(panel).getByRole('button', { name: /^Fewer/ });
    expect(fewer).toHaveTextContent('Fewer ▴');
    expect(fewer).toHaveAttribute('aria-expanded', 'true');
    expect(panel.lastElementChild).toHaveTextContent(/Referred \/ extended \(2\)/); // history link still last
    fireEvent.click(fewer);
    expect(names(panel)).toHaveLength(5);
  });

  it('no toggle at 5 rows or fewer; the history link stays at the bottom of Late work', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, lateWork: lateRows(5) });
    renderSection();
    const panel = await latePanel();
    expect(names(panel)).toHaveLength(5);
    expect(within(panel).queryByRole('button', { name: /^All \d/ })).not.toBeInTheDocument();
    expect(panel.lastElementChild).toHaveTextContent(/Referred \/ extended \(2\)/);
  });

  it('each panel keeps its own state, remembered for the session per panel + scope', async () => {
    const owed = Array.from({ length: 6 }, (_, i) => ({ ...PAYLOAD.feedbackOwed[0], assignmentId: 50 + i, title: `Task ${i + 1}` }));
    api.getTriage.mockResolvedValue({ ...PAYLOAD, lateWork: lateRows(7), feedbackOwed: owed });
    const first = renderSection();
    const panel = await latePanel();
    fireEvent.click(within(panel).getByRole('button', { name: /^All 7/ }));
    const feedback = screen.getByLabelText('Feedback owed');
    expect(within(feedback).getByRole('button', { name: /^All 6/ })).toHaveAttribute('aria-expanded', 'false');
    // The Formative checkbox comes after the toggle in the header.
    const head = [...feedback.querySelector('.triage-panel__head').querySelectorAll('button, input')];
    expect(head.map((el) => el.tagName)).toEqual(['BUTTON', 'INPUT']);
    first.unmount();
    renderSection();
    expect(names(await latePanel())).toHaveLength(7);
    expect(within(screen.getByLabelText('Feedback owed')).getAllByRole('link', { name: /^Task/ })).toHaveLength(5);
  });

  it('a course page remembers its own state, separate from the dashboard', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, lateWork: lateRows(7) });
    const dash = renderSection();
    fireEvent.click(within(await latePanel()).getByRole('button', { name: /^All 7/ }));
    dash.unmount();
    renderSection({ courseId: 5 });
    expect(names(await latePanel())).toHaveLength(5);
  });
});

describe('TriageSection — make-up tests', () => {
  it('stacks first in the rail, above the late-work and feedback panels', async () => {
    renderSection();
    await screen.findByText('Noah Park');
    expect(screen.getAllByRole('region').map((el) => el.getAttribute('aria-label')))
      .toEqual(['Make-up tests', 'Late work', 'Feedback owed']);
    const panel = await makeUpPanel();
    expect(panel.parentElement).not.toHaveClass('triage-grid');
  });

  it('title + red badge, subtitle, rows with course chip, meter, day count and extension tag', async () => {
    renderSection();
    const panel = await makeUpPanel();
    expect(within(panel).getByText('1 overdue')).toHaveClass('badge-red');
    expect(within(panel).getByText('test day = day 1 · sit by day 3')).toBeInTheDocument();
    expect(within(panel).getByText('[BK 3] AP CSP')).toBeInTheDocument();
    expect(within(panel).getByText('Noah Park')).toBeInTheDocument();
    expect(within(panel).getByText('Unit 1 test')).toBeInTheDocument();
    expect(within(panel).getByRole('img', { name: 'day 4, limit day 4' })).toBeInTheDocument();
    expect(within(panel).getByText('ext +2 → 20/10/2026')).toBeInTheDocument();
    expect(within(panel).getAllByText('Extend')).toHaveLength(2); // visible on every row, no expand needed
    expect(within(panel).queryByRole('button', { name: 'Refer' })).not.toBeInTheDocument();
  });

  it('no course chip on a course page', async () => {
    renderSection({ courseId: 8 });
    const panel = await makeUpPanel();
    expect(within(panel).queryByText('[BK 3] AP CSP')).not.toBeInTheDocument();
  });

  it('empty state', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, makeUps: [] });
    renderSection();
    expect(within(await makeUpPanel()).getByText('No missed tests.')).toBeInTheDocument();
  });

  it("says when tests couldn't be checked", async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, makeUpsUnchecked: 2 });
    renderSection();
    expect(within(await makeUpPanel()).getByText("Couldn't check 2 tests — run a full sync.")).toBeInTheDocument();
    api.getTriage.mockResolvedValue({ ...PAYLOAD, makeUps: [], makeUpsUnchecked: 1 });
    renderSection();
    expect(await screen.findByText("Couldn't check 1 test — run a full sync.")).toBeInTheDocument();
  });

  it('no unchecked note when everything was checked', async () => {
    renderSection();
    expect(within(await makeUpPanel()).queryByText(/Couldn't check/)).not.toBeInTheDocument();
  });

  it('Extend on a make-up row is pre-filled from its extension and posts it, then reloads', async () => {
    renderSection();
    const panel = await makeUpPanel();
    const zoe = rowOf(within(panel).getByText('Zoe Tan'));
    fireEvent.click(within(zoe).getByText('Extend')); // Zoe: ext +2, "sits Tue"
    expect(within(panel).getByLabelText('Extension (lessons)')).toHaveValue(2);
    expect(within(panel).getByLabelText('Extension note')).toHaveValue('sits Tue');
    fireEvent.click(within(panel).getByLabelText('Increase'));
    fireEvent.click(within(panel).getByText('Save'));
    await waitFor(() => expect(api.recordExtension).toHaveBeenCalledWith({ studentId: 8, assignmentId: 21, lessons: 3, note: 'sits Tue' }));
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledTimes(2));
  });
});

describe('TriageSection — reload on a version bump', () => {
  it('re-fetches without remounting: Show formative stays on', async () => {
    const { rerender } = render(<MemoryRouter><TriageSection courseId={5} version={0} /></MemoryRouter>);
    fireEvent.click(await screen.findByLabelText('Show formative'));
    await waitFor(() => expect(api.getTriage).toHaveBeenLastCalledWith({ courseId: 5, includeFormative: true }));
    const calls = api.getTriage.mock.calls.length;
    rerender(<MemoryRouter><TriageSection courseId={5} version={1} /></MemoryRouter>);
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledTimes(calls + 1));
    expect(api.getTriage).toHaveBeenLastCalledWith({ courseId: 5, includeFormative: true });
  });
});

describe('TriageSection — ignore a quiz for make-ups', () => {
  it('Ignore this test asks inline, then ignores it for all students and reloads', async () => {
    const onMakeUpIgnored = vi.fn();
    renderSection({ onMakeUpIgnored });
    const panel = await makeUpPanel();
    const noah = rowOf(within(panel).getByText('Noah Park'));
    fireEvent.click(within(noah).getByText('Ignore this test')); // Noah's Unit 1 test
    expect(within(panel).getByText('Ignore Unit 1 test for all students?')).toBeInTheDocument();
    fireEvent.click(within(panel).getByText('Yes'));
    await waitFor(() => expect(api.setMakeUpIgnored).toHaveBeenCalledWith(20, true));
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledTimes(2));
    expect(onMakeUpIgnored).toHaveBeenCalledWith(20);
  });

  it('Cancel leaves it tracked', async () => {
    renderSection();
    const panel = await makeUpPanel();
    const noah = rowOf(within(panel).getByText('Noah Park'));
    fireEvent.click(within(noah).getByText('Ignore this test'));
    fireEvent.click(within(panel).getByText('Cancel'));
    expect(within(panel).queryByText(/for all students\?/)).not.toBeInTheDocument();
    expect(api.setMakeUpIgnored).not.toHaveBeenCalled();
  });

  it('says how many tests are ignored', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, makeUpsIgnored: 2 });
    renderSection();
    expect(within(await makeUpPanel()).getByText('2 tests ignored')).toBeInTheDocument();
    api.getTriage.mockResolvedValue({ ...PAYLOAD, makeUps: [], makeUpsIgnored: 1 });
    renderSection();
    expect(await screen.findByText('1 test ignored')).toBeInTheDocument();
  });
});

const RESUB = [
  { id: null, state: 'arrived', studentId: 11, studentName: 'Lena Ho', courseId: 5, courseName: 'AIML', assignmentId: 30, schoologyAssignmentId: 'r30', title: 'Launch - Design', day: 3, limit: 10, tone: 'green', approx: false, lessons: null, until: null, requestedOn: null, arrivedOn: '2026-10-14', source: null, afterDeadline: false, note: null },
  { id: 41, state: 'waiting', studentId: 12, studentName: 'Ravi Shah', courseId: 5, courseName: 'AIML', assignmentId: 30, schoologyAssignmentId: 'r30', title: 'Launch - Design', day: 6, limit: 4, tone: 'red', approx: false, lessons: 3, until: '2026-10-14', requestedOn: '2026-10-09', arrivedOn: null, source: 'schoology_unsubmit', afterDeadline: false, note: null },
];

describe('Resubmissions panel', () => {
  it('is hidden when there are no resubmission rows', async () => {
    renderSection();
    await latePanel();
    expect(screen.queryByLabelText('Resubmissions')).toBeNull();
  });
  it('lists arrived then waiting, with tags, and wires Reviewed / Close / Extend', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, resubmissions: RESUB, resubmissionHistoryCount: 2, counts: { resubmissionsOverdue: 1 } });
    api.reviewResubmission.mockResolvedValue({}); api.updateResubmission.mockResolvedValue({});
    renderSection();
    const panel = await screen.findByLabelText('Resubmissions');
    const names = within(panel).getAllByRole('link').map((l) => l.textContent);
    expect(names).toEqual(['Lena Ho', 'Ravi Shah']);
    expect(within(panel).getByText('↩ arrived')).toBeTruthy();
    expect(within(panel).getByText('unsubmitted in Schoology')).toBeTruthy();
    expect(within(panel).getByText('1 overdue')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Reviewed' }));
    await waitFor(() => expect(api.reviewResubmission).toHaveBeenCalledWith({ studentId: 11, assignmentId: 30 }));

    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    fireEvent.change(within(panel).getByLabelText('Close note'), { target: { value: 'grade stands' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm close' }));
    await waitFor(() => expect(api.updateResubmission).toHaveBeenCalledWith(41, { close: true, note: 'grade stands' }));
  });
  it('row names link to the student card on the assessment page', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, resubmissions: RESUB, counts: {} });
    renderSection();
    const panel = await screen.findByLabelText('Resubmissions');
    expect(within(panel).getByRole('link', { name: 'Lena Ho' }).getAttribute('href')).toBe('/course/5/assessment/r30?student=11');
  });
});
