import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
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
  undoResubmission: vi.fn(),
  previewStatusLine: vi.fn(),
  getLessonPlan: vi.fn().mockResolvedValue(null), getStatusLineUntil: vi.fn(),
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
    { studentId: 8, studentName: 'Zoe Tan', courseId: 5, courseName: 'AP CSP', assignmentId: 21, schoologyAssignmentId: 'q21', title: 'Unit 2 quiz', dueDate: '2026-10-15', daysSince: 0, day: 1, tone: 'green', approx: false, extension: { id: 9, lessons: 2, until: '2026-10-20', note: 'sits Tue', schoolDaysLeft: 2 } },
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
  api.updateResubmission.mockResolvedValue({});
  api.undoResubmission.mockResolvedValue({});
  api.undoExtension.mockResolvedValue({ deleted: true });
  api.previewStatusLine.mockResolvedValue({ currentComment: 'Good effort.', visible: true, storedLine: null, hiddenWarning: false });
  api.getStatusLineUntil.mockResolvedValue({ until: '2026-10-16', lessons: 4 });
});

// The StatusLineModal confirm (portalled to <body>).
const dialog = () => screen.findByRole('dialog');
const publishBtn = async (name) => {
  await screen.findByLabelText('Their comment will read');
  return within(screen.getByRole('dialog')).getByRole('button', { name });
};
const SCHOOLOGY_WRITES = ['recordExtension', 'updateResubmission', 'undoResubmission', 'undoExtension'];

describe('TriageSection', () => {
  it('renders both panels with counts, tags and course chips (all-courses view)', async () => {
    renderSection();
    expect(await screen.findByText('Maya Chen')).toBeInTheDocument();
    expect(screen.getByText('2 to refer')).toBeInTheDocument();
    expect(screen.getByText('submitted 10 school days late')).toBeInTheDocument();
    expect(screen.getByTitle('18 of 22 ungraded')).toHaveTextContent('18/22');
    expect(screen.getAllByText('AP CSP').length).toBeGreaterThan(0);
    expect(screen.getAllByText('[BK 7] AP CSP')).toHaveLength(2); // one late row + one feedback row
    expect(screen.getByText('ext → 15/10/2026')).toBeInTheDocument();
    expect(screen.getByText(/Referred \/ waived \/ extended \(2\)/)).toBeInTheDocument();
    expect(screen.getByText('school days late · refer at 8')).toBeInTheDocument();
  });

  it('Referred / waived / extended opens the history inside the Late work panel, right below the link; the link and Close both toggle it', async () => {
    renderSection();
    const panel = await latePanel();
    const link = within(panel).getByText(/Referred \/ waived \/ extended \(2\)/);
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

  it('missing work offers Extend; work handed in late offers Waive instead; Refer only on red rows', async () => {
    renderSection();
    const panel = await latePanel();
    expect(within(panel).getAllByRole('button', { name: 'Refer' })).toHaveLength(2); // inline Refer, red rows
    expect(within(panel).getAllByText('Extend')).toHaveLength(2); // Maya, Aiden: still missing
    const ethan = rowOf(within(panel).getByText('Ethan Wong')); // submitted late: the work is in
    expect(within(ethan).queryByText('Extend')).not.toBeInTheDocument();
    expect(within(ethan).getByRole('button', { name: 'Waive' })).toBeInTheDocument();
    expect(screen.queryByText('Exempt')).not.toBeInTheDocument();
  });

  it('Waive → an optional note → "Waive referral" records it as waived, then reloads', async () => {
    renderSection();
    const ethan = rowOf(within(await latePanel()).getByText('Ethan Wong'));
    fireEvent.click(within(ethan).getByRole('button', { name: 'Waive' }));
    fireEvent.change(within(ethan).getByLabelText('Waive note'), { target: { value: 'pre-approved absence' } });
    fireEvent.click(within(ethan).getByRole('button', { name: 'Waive referral' }));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 2, assignmentId: 9, action: 'waived', note: 'pre-approved absence' }));
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledTimes(2));
  });

  it('Extend → Save opens the confirm; Publish posts N lessons, the note and the extension line, then reloads', async () => {
    renderSection();
    const maya = rowOf(within(await latePanel()).getByText('Maya Chen'));
    fireEvent.click(within(maya).getByText('Extend')); // Maya: no extension yet
    const lessons = screen.getByLabelText('Extension (school days)');
    expect(lessons).toHaveValue(3);
    expect(lessons).toHaveAttribute('max', '60');
    expect(screen.getByLabelText('Extension note')).toHaveValue('');
    fireEvent.click(screen.getByLabelText('Increase'));
    fireEvent.change(screen.getByLabelText('Extension note'), { target: { value: 'sick week' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await dialog()).toHaveAccessibleName("Publish to Maya Chen's Schoology comment");
    const line = 'Extension - now due Fri 16/10 (4 school days). sick week';
    expect(await screen.findByDisplayValue(line)).toBeInTheDocument();
    expect(api.getStatusLineUntil).toHaveBeenCalledWith({ kind: 'extension', studentId: 1, assignmentId: 9, lessons: 4 });
    expect(api.recordExtension).not.toHaveBeenCalled();
    fireEvent.click(await publishBtn('Publish new due date'));
    await waitFor(() => expect(api.recordExtension).toHaveBeenCalledWith({ studentId: 1, assignmentId: 9, lessons: 4, note: 'sick week', commentLine: line }));
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByLabelText('Extension (school days)')).not.toBeInTheDocument();
  });

  it('Cancel in the extension confirm writes nothing', async () => {
    renderSection();
    const maya = rowOf(within(await latePanel()).getByText('Maya Chen'));
    fireEvent.click(within(maya).getByText('Extend'));
    fireEvent.click(screen.getByText('Save'));
    await publishBtn('Publish new due date');
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    for (const fn of SCHOOLOGY_WRITES) expect(api[fn]).not.toHaveBeenCalled();
    expect(api.getTriage).toHaveBeenCalledTimes(1);
  });

  it('a failed publish keeps the confirm open with the server error; nothing reloads', async () => {
    api.recordExtension.mockRejectedValue(new Error("Couldn't read the grade from Schoology: nothing was published or recorded"));
    renderSection();
    const maya = rowOf(within(await latePanel()).getByText('Maya Chen'));
    fireEvent.click(within(maya).getByText('Extend'));
    fireEvent.click(screen.getByText('Save'));
    fireEvent.click(await publishBtn('Publish new due date'));
    expect(await within(await dialog()).findByText(/nothing was published or recorded/)).toBeInTheDocument();
    expect(api.getTriage).toHaveBeenCalledTimes(1);
  });

  it('published but not recorded: the confirm says so and the lists reload', async () => {
    api.recordExtension.mockRejectedValue(Object.assign(new Error("The comment WAS published to the student's Schoology comment, but Prism could not record the action (x)."), { code: 'RECORD_FAILED_AFTER_PUBLISH', published: true }));
    renderSection();
    const maya = rowOf(within(await latePanel()).getByText('Maya Chen'));
    fireEvent.click(within(maya).getByText('Extend'));
    fireEvent.click(screen.getByText('Save'));
    fireEvent.click(await publishBtn('Publish new due date'));
    expect(await screen.findByText('Published to Schoology: not recorded in Prism')).toBeInTheDocument();
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledTimes(2));
  });

  it('re-extending pre-fills the school days still left on the current extension, and its note', async () => {
    const lateWork = PAYLOAD.lateWork.map((r) => (r.studentId === 3 ? { ...r, extension: { id: 4, lessons: 3, until: '2026-10-21', note: 'trip', schoolDaysLeft: 5 } } : r));
    api.getTriage.mockResolvedValue({ ...PAYLOAD, lateWork });
    renderSection();
    const aiden = rowOf(within(await latePanel()).getByText('Aiden Li'));
    fireEvent.click(within(aiden).getByText('Extend'));
    expect(screen.getByLabelText('Extension (school days)')).toHaveValue(5);
    expect(screen.getByLabelText('Extension note')).toHaveValue('trip');
  });

  it('Extend → Cancel closes the editor without posting', async () => {
    renderSection();
    const maya = rowOf(within(await latePanel()).getByText('Maya Chen'));
    fireEvent.click(within(maya).getByText('Extend'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByLabelText('Extension (school days)')).not.toBeInTheDocument();
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
    fireEvent.click(await screen.findByText(/Referred \/ waived \/ extended \(2\)/));
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
    fireEvent.click(await screen.findByText(/Referred \/ waived \/ extended \(2\)/));
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
    fireEvent.click(await screen.findByText(/Referred \/ waived \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('Extended to 15/10/2026')).toBeInTheDocument();
    expect(within(history).getByText('Referred · 9 school days late')).toBeInTheDocument();
    // Newest first: the extension (02/10) above the referral (01/10).
    expect(within(history).getAllByText(/Aiden Li|Maya Chen/).map((el) => el.textContent)).toEqual(['Aiden Li', 'Maya Chen']);
    fireEvent.click(within(history).getAllByText('Undo')[0]);
    // An extension may have published a line: Undo confirms first, offering to remove it.
    expect(await dialog()).toHaveAccessibleName("Undo: Aiden Li's Schoology comment");
    expect(api.undoExtension).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: "Remove Prism's line from their comment" })).toBeChecked();
    fireEvent.click(await publishBtn('Undo'));
    await waitFor(() => expect(api.undoExtension).toHaveBeenCalledWith(7, { removeLine: true }));
    expect(api.undoReferral).not.toHaveBeenCalled();
  });

  it('history: a failed half shows its own inline error and the other half still lists', async () => {
    api.getReferrals.mockRejectedValue(new Error('Server unreachable'));
    api.getExtensions.mockResolvedValue([
      { id: 7, lessons: 3, until: '2026-10-15', createdAt: '2026-09-01 01:00:00', updatedAt: '2026-10-03 01:00:00', studentName: 'Aiden Li', courseName: 'AP CSP', title: 'CP2', note: null },
    ]);
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ waived \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('Extended to 15/10/2026')).toBeInTheDocument();
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
    fireEvent.click(await screen.findByText(/Referred \/ waived \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('Referred · 9 school days late')).toBeInTheDocument();
    expect(within(history).getByText(/Couldn't load extensions: boom/)).toBeInTheDocument();
  });

  it('an open history reloads after Mark referred', async () => {
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ waived \/ extended \(2\)/));
    await waitFor(() => expect(api.getReferrals).toHaveBeenCalledTimes(1));
    fireEvent.click(referButtons()[0]);
    await waitFor(() => expect(api.getReferrals).toHaveBeenCalledTimes(2));
  });
});

describe('TriageSection — deep link to the student card (Task 10)', () => {
  it('late work and make-up names link to the student card', async () => {
    renderSection();
    const late = await latePanel();
    expect(within(late).getByRole('link', { name: 'Maya Chen' }).getAttribute('href')).toBe('/course/5/assessment/a9?student=1');
    const mk = await makeUpPanel();
    expect(within(mk).getByRole('link', { name: 'Noah Park' }).getAttribute('href')).toBe('/course/8/assessment/q20?student=7');
  });
});

describe('TriageSection — compact rows', () => {
  const textOf = (row) => row.querySelector('.triage-row__text');

  it('late-work row: 28px ring, then name (link) + tag / course / title, each one line with a full-text title', async () => {
    renderSection();
    const panel = await latePanel();
    const row = rowOf(within(panel).getByText('Aiden Li'));
    expect(row.firstElementChild).toHaveAttribute('aria-label', '2 school days');
    expect(row.firstElementChild.querySelector('svg')).toHaveAttribute('width', '28');
    const lines = [...textOf(row).children];
    expect(lines.map((el) => el.className)).toEqual(['triage-row__line', 'triage-row__course', 'triage-row__task']);
    const name = within(lines[0]).getByRole('link', { name: 'Aiden Li' });
    expect(name).toHaveAttribute('href', '/course/6/assessment/a9?student=3');
    expect(name).toHaveAttribute('title', 'Aiden Li');
    expect(lines[0]).toHaveTextContent('Aiden Liext → 15/10/2026'); // the tag sits beside the name
    expect(lines[1]).toHaveTextContent('[BK 7] AP CSP');
    expect(lines[1]).toHaveAttribute('title', '[BK 7] AP CSP');
    expect(lines[2]).toHaveTextContent(/^CP2$/);
    expect(lines[2]).toHaveAttribute('title', 'CP2');
  });

  it('red late-work row: the submitted-day tag beside the name; an inline primary Refer button', async () => {
    renderSection();
    const row = rowOf(within(await latePanel()).getByText('Ethan Wong'));
    expect(within(row).getByRole('img', { name: '10 school days' })).toBeInTheDocument();
    expect(row.querySelector('.triage-row__line')).toHaveTextContent('Ethan Wongsubmitted 10 school days late');
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
    expect(within(row).getByRole('img', { name: '7 school days' })).toHaveTextContent('7');
    expect(within(row.querySelector('.triage-row__actions')).getByText('last day')).toBeInTheDocument();
    expect(within(row).queryByText(/left/)).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Refer' })).not.toBeInTheDocument();
  });

  it('short subtitles in the rail', async () => {
    renderSection();
    expect(within(await makeUpPanel()).getByText('school days since the test · sit within 2')).toBeInTheDocument();
    expect(within(await latePanel()).getByText('school days late · refer at 8')).toBeInTheDocument();
    const panel = await screen.findByLabelText('Feedback owed');
    expect(within(panel).getByText('school days waiting · overdue at 10')).toBeInTheDocument();
  });

  it('feedback row: ring, then title (link, full-text title) / course, then the count right-aligned as "X/Y"', async () => {
    renderSection();
    const panel = await screen.findByLabelText('Feedback owed');
    const row = rowOf(within(panel).getByText('Model Card'));
    expect(row.firstElementChild).toHaveAttribute('aria-label', '11 school days');
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
    expect(row.firstElementChild).toHaveAttribute('aria-label', '3 school days');
    expect([...textOf(row).children].map((el) => el.textContent)).toEqual(['Noah Park', '[BK 3] AP CSP', 'Unit 1 test']);
    const actions = row.querySelector('.triage-row__actions');
    expect([...actions.children].map((el) => el.textContent)).toEqual(['Extend', 'Ignore this test']);
    expect(within(actions).getByText('Extend')).toHaveClass('secondary');
    expect(within(actions).getByText('Ignore this test')).toHaveClass('secondary');
  });

  it('make-up row: the extension tag sits beside the name', async () => {
    renderSection();
    const row = rowOf(within(await makeUpPanel()).getByText('Zoe Tan'));
    expect(row.querySelector('.triage-row__line')).toHaveTextContent('Zoe Tanext → 20/10/2026');
  });

  it('the Extend editor opens below the row without expanding, and without removing the action buttons', async () => {
    renderSection();
    const row = rowOf(within(await latePanel()).getByText('Maya Chen'));
    const actions = row.querySelector('.triage-row__actions');
    fireEvent.click(within(actions).getByText('Extend'));
    const more = row.querySelector('.triage-row__more');
    expect(within(more).getByLabelText('Extension (school days)')).toBeInTheDocument();
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
    expect(within(more).queryByLabelText('Extension (school days)')).not.toBeInTheDocument();
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
    expect(panel.lastElementChild).toHaveTextContent(/Referred \/ waived \/ extended \(2\)/); // history link still last
    fireEvent.click(fewer);
    expect(names(panel)).toHaveLength(5);
  });

  it('no toggle at 5 rows or fewer; the history link stays at the bottom of Late work', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, lateWork: lateRows(5) });
    renderSection();
    const panel = await latePanel();
    expect(names(panel)).toHaveLength(5);
    expect(within(panel).queryByRole('button', { name: /^All \d/ })).not.toBeInTheDocument();
    expect(panel.lastElementChild).toHaveTextContent(/Referred \/ waived \/ extended \(2\)/);
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
    expect(within(panel).getByText('school days since the test · sit within 2')).toBeInTheDocument();
    expect(within(panel).getByText('[BK 3] AP CSP')).toBeInTheDocument();
    expect(within(panel).getByText('Noah Park')).toBeInTheDocument();
    expect(within(panel).getByText('Unit 1 test')).toBeInTheDocument();
    expect(within(panel).getByRole('img', { name: '3 school days' })).toBeInTheDocument();
    expect(within(panel).getByText('ext → 20/10/2026')).toBeInTheDocument();
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
    expect(within(await makeUpPanel()).getByText("Couldn't check 2 tests: run a full sync.")).toBeInTheDocument();
    api.getTriage.mockResolvedValue({ ...PAYLOAD, makeUps: [], makeUpsUnchecked: 1 });
    renderSection();
    expect(await screen.findByText("Couldn't check 1 test: run a full sync.")).toBeInTheDocument();
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
    expect(within(panel).getByLabelText('Extension (school days)')).toHaveValue(2);
    expect(within(panel).getByLabelText('Extension note')).toHaveValue('sits Tue');
    fireEvent.click(within(panel).getByLabelText('Increase'));
    fireEvent.click(within(panel).getByText('Save'));
    const line = 'Make-up - sit by Fri 16/10. sits Tue';
    expect(await screen.findByDisplayValue(line)).toBeInTheDocument();
    expect(api.getStatusLineUntil).toHaveBeenCalledWith({ kind: 'make_up', studentId: 8, assignmentId: 21, lessons: 3 });
    fireEvent.click(await publishBtn('Publish new due date'));
    await waitFor(() => expect(api.recordExtension).toHaveBeenCalledWith({ studentId: 8, assignmentId: 21, lessons: 3, note: 'sits Tue', commentLine: line }));
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

const RESUB3 = [
  ...RESUB,
  { id: 42, state: 'waiting', studentId: 13, studentName: 'Ivy Lam', courseId: 5, courseName: 'AIML', assignmentId: 30, schoologyAssignmentId: 'r30', title: 'Launch - Design', day: 2, limit: 4, tone: 'green', approx: false, lessons: 3, until: '2026-10-20', requestedOn: '2026-10-15', arrivedOn: null, source: 'app', afterDeadline: false, note: 'add tests' },
];

describe('Resubmissions panel', () => {
  const resubPanel = async (rows = RESUB3, extra = {}) => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, resubmissions: rows, resubmissionHistoryCount: 2, counts: {}, ...extra });
    renderSection();
    return screen.findByLabelText('Resubmissions');
  };
  const actionsOf = (panel, name) => rowOf(within(panel).getByText(name)).querySelector('.triage-row__actions');

  it('a row whose LTI unsubmit failed says so and links the Schoology assignment page (new tab)', async () => {
    const url = 'https://schoology.hkis.edu.hk/assignments/r30/info';
    const panel = await resubPanel([{ ...RESUB3[2], unsubmitError: 'Schoology connection expired: reconnect in Settings', unsubmitUrl: url }]);
    const link = within(panel).getByRole('link', { name: 'unsubmit it in Schoology ›' });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    expect(within(panel).getByText(/Unsubmit failed/)).toBeInTheDocument();
  });

  it('Grade stands on unsubmitted OneDrive work says it stays unsubmitted', async () => {
    const panel = await resubPanel([{ ...RESUB[1], ltiState: 'in_progress' }]);
    fireEvent.click(within(panel).getByRole('button', { name: 'Grade stands' }));
    await dialog();
    expect(screen.getByText('Ends the resubmission request: missed deadline, grade stands. Their work stays unsubmitted in Schoology.')).toBeInTheDocument();
  });

  it('is hidden when there are no resubmission rows', async () => {
    renderSection();
    await latePanel();
    expect(screen.queryByLabelText('Resubmissions')).toBeNull();
  });

  it('lists rows with tags; arrived = "↩ arrived · awaiting feedback" and no button', async () => {
    const panel = await resubPanel();
    expect(within(panel).getAllByRole('link').map((l) => l.textContent)).toEqual(['Lena Ho', 'Ravi Shah', 'Ivy Lam']);
    expect(within(panel).getByText('↩ arrived · awaiting feedback')).toBeInTheDocument();
    expect(within(panel).getByText('unsubmitted in Schoology')).toBeInTheDocument();
    expect(within(panel).getByText('1 overdue')).toBeInTheDocument();
    expect(actionsOf(panel, 'Lena Ho')).toBeNull();
    expect(within(rowOf(within(panel).getByText('Lena Ho'))).queryByRole('button')).not.toBeInTheDocument();
  });

  it('Grade stands only on the red (past-deadline) Waiting row; before the deadline "N left" + Extend, no Close', async () => {
    const panel = await resubPanel();
    expect([...actionsOf(panel, 'Ravi Shah').children].map((el) => el.textContent)).toEqual(['Grade stands', 'Extend']);
    expect([...actionsOf(panel, 'Ivy Lam').children].map((el) => el.textContent)).toEqual(['2 left', 'Extend']);
    expect(within(panel).getAllByRole('button', { name: 'Grade stands' })).toHaveLength(1);
    expect(within(panel).queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
  });

  it('no Reviewed button anywhere', async () => {
    await resubPanel();
    expect(screen.queryByRole('button', { name: 'Reviewed' })).not.toBeInTheDocument();
    expect(screen.queryByText('Reviewed')).not.toBeInTheDocument();
  });

  it('Grade stands opens the confirm with its consequence and line, then publishes it', async () => {
    const panel = await resubPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Grade stands' }));
    const modal = await dialog();
    expect(modal).toHaveAccessibleName("Publish to Ravi Shah's Schoology comment");
    expect(within(modal).getByText('Ends the resubmission request: missed deadline, grade stands.')).toBeInTheDocument();
    const line = 'Resubmission deadline (Wed 14/10) passed - your grade stands.';
    expect(within(modal).getByLabelText('Status line')).toHaveValue(line);
    expect(api.updateResubmission).not.toHaveBeenCalled();
    fireEvent.click(await publishBtn('Publish & close request'));
    await waitFor(() => expect(api.updateResubmission).toHaveBeenCalledWith(41, { gradeStands: true, commentLine: line }));
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledTimes(2));
  });

  it('Grade stands → Cancel never calls a write API', async () => {
    const panel = await resubPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Grade stands' }));
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    for (const fn of SCHOOLOGY_WRITES) expect(api[fn]).not.toHaveBeenCalled();
  });

  it('Extend (no note field) → Save opens the confirm with the new due date; Publish sends lessons + commentLine', async () => {
    const panel = await resubPanel();
    const ivy = rowOf(within(panel).getByText('Ivy Lam'));
    fireEvent.click(within(ivy).getByRole('button', { name: 'Extend' }));
    expect(within(ivy).getByLabelText('Extension (school days)')).toHaveValue(2); // limit 4 - day 2: school days left
    expect(within(ivy).queryByLabelText('Extension note')).not.toBeInTheDocument();
    fireEvent.click(within(ivy).getByLabelText('Increase'));
    fireEvent.click(within(ivy).getByRole('button', { name: 'Save' }));
    const line = 'Resubmission requested - now due Fri 16/10.';
    expect(await screen.findByDisplayValue(line)).toBeInTheDocument();
    expect(api.getStatusLineUntil).toHaveBeenCalledWith({ kind: 'extend_resubmission', studentId: 13, assignmentId: 30, resubmissionId: 42, lessons: 3 });
    fireEvent.click(await publishBtn('Publish new due date'));
    await waitFor(() => expect(api.updateResubmission).toHaveBeenCalledWith(42, { lessons: 3, commentLine: line }));
  });

  it('row names link to the student card on the assessment page', async () => {
    const panel = await resubPanel();
    expect(within(panel).getByRole('link', { name: 'Lena Ho' }).getAttribute('href')).toBe('/course/5/assessment/r30?student=11');
  });

  it('stays mounted after acting on the last row: "All caught up." and the history link remain', async () => {
    api.getTriage.mockResolvedValueOnce({ ...PAYLOAD, resubmissions: [RESUB[1]], resubmissionHistoryCount: 1, counts: {} });
    api.getTriage.mockResolvedValueOnce({ ...PAYLOAD, resubmissions: [], resubmissionHistoryCount: 2, counts: {} });
    renderSection();
    const panel = await screen.findByLabelText('Resubmissions');
    fireEvent.click(within(panel).getByRole('button', { name: 'Grade stands' }));
    fireEvent.click(await publishBtn('Publish & close request'));
    await waitFor(() => expect(api.updateResubmission).toHaveBeenCalled());
    const after = await screen.findByLabelText('Resubmissions'); // still mounted, not unmounted-then-remounted
    await waitFor(() => expect(within(after).getByText('All caught up.')).toBeInTheDocument());
    expect(within(after).getByRole('button', { name: /^History \(2\)/ })).toBeInTheDocument();
  });

  describe('history', () => {
    const HISTORY = [
      { id: 50, outcome: 'asked', studentId: 12, assignmentId: 30, studentName: 'Ravi Shah', title: 'CP1', courseName: 'AIML', until: '2026-10-14', updatedAt: '2026-10-12 01:00:00', createdAt: '2026-10-09 01:00:00' },
      { id: 51, outcome: 'grade_stands', studentId: 11, assignmentId: 30, studentName: 'Maya Chen', title: 'CP1', courseName: 'AIML', closeNote: 'grade stands', updatedAt: '2026-10-11 01:00:00', createdAt: '2026-10-09 01:00:00' },
      { id: 52, outcome: 'done', studentId: 13, assignmentId: 30, studentName: 'Ivy Lam', title: 'CP1', courseName: 'AIML', updatedAt: '2026-10-10 01:00:00', createdAt: '2026-10-09 01:00:00' },
      { id: 53, outcome: 'undone', studentId: 14, assignmentId: 30, studentName: 'Noah Park', title: 'CP1', courseName: 'AIML', updatedAt: '2026-10-09 03:00:00', createdAt: '2026-10-09 01:00:00' },
      { id: 54, outcome: 'closed', studentId: 15, assignmentId: 30, studentName: 'Zoe Tan', title: 'CP1', courseName: 'AIML', updatedAt: '2026-10-09 02:00:00', createdAt: '2026-10-09 01:00:00' },
    ];
    async function openHistory() {
      api.getResubmissions.mockResolvedValue(HISTORY);
      const panel = await resubPanel();
      fireEvent.click(within(panel).getByRole('button', { name: /^History/ }));
      const history = await screen.findByLabelText('Resubmission history');
      await within(history).findByText('Ravi Shah');
      return history;
    }
    const undoOf = (history, name) => within(rowOf(within(history).getByText(name))).getByRole('button', { name: 'Undo' });

    it('labels each outcome', async () => {
      const history = await openHistory();
      expect(within(history).getAllByText(/^(Asked|Missed|Resubmitted|Undone|Closed)/).map((el) => el.textContent)).toEqual([
        'Asked · by 14/10/2026', 'Missed deadline · grade stands', 'Resubmitted · feedback given', 'Undone', 'Closed',
      ]);
      expect(within(history).queryByText(/— grade stands/)).not.toBeInTheDocument(); // not repeated as a note
    });

    it('Undo of an ask confirms first (remove line, default on) → undoResubmission(id, { removeLine: true })', async () => {
      const history = await openHistory();
      fireEvent.click(undoOf(history, 'Ravi Shah'));
      expect(await dialog()).toHaveAccessibleName("Undo: Ravi Shah's Schoology comment");
      expect(api.undoResubmission).not.toHaveBeenCalled();
      fireEvent.click(await publishBtn('Undo'));
      await waitFor(() => expect(api.undoResubmission).toHaveBeenCalledWith(50, { removeLine: true }));
    });

    it('Undo of grade stands with the box unchecked → no removeLine', async () => {
      const history = await openHistory();
      fireEvent.click(undoOf(history, 'Maya Chen'));
      fireEvent.click(within(await dialog()).getByRole('checkbox', { name: "Remove Prism's line from their comment" }));
      fireEvent.click(await publishBtn('Undo'));
      await waitFor(() => expect(api.undoResubmission).toHaveBeenCalledWith(51, { removeLine: false }));
    });

    it("Undo previews against the record's own line: another action's line stays", async () => {
      api.previewStatusLine.mockResolvedValue({ currentComment: 'L9\n\nGood.', visible: true, storedLine: 'L9', storedSource: { sourceType: 'resubmission', sourceId: 77 }, hiddenWarning: false });
      const history = await openHistory();
      fireEvent.click(undoOf(history, 'Ravi Shah'));
      expect(await within(await dialog()).findByText("Prism's current line belongs to a different action. It will stay.")).toBeInTheDocument();
      expect(screen.getByLabelText('Their comment will read').textContent).toBe('L9\n\nGood.');
    });

    it('Undo of an auto-added (Schoology Unsubmit) request says it closes it', async () => {
      api.getResubmissions.mockResolvedValue([{ ...HISTORY[0], source: 'schoology_unsubmit' }]);
      const panel = await resubPanel();
      fireEvent.click(within(panel).getByRole('button', { name: /^History/ }));
      const history = await screen.findByLabelText('Resubmission history');
      fireEvent.click(await within(history).findByRole('button', { name: 'Undo' }));
      expect(within(await dialog()).getByText('Closes this resubmission request in Prism.')).toBeInTheDocument();
    });

    it('Undo of an ask whose OneDrive work is now unsubmitted says it closes it and the work stays unsubmitted', async () => {
      api.getResubmissions.mockResolvedValue([{ ...HISTORY[0], ltiState: 'in_progress' }]);
      const panel = await resubPanel();
      fireEvent.click(within(panel).getByRole('button', { name: /^History/ }));
      const history = await screen.findByLabelText('Resubmission history');
      fireEvent.click(await within(history).findByRole('button', { name: 'Undo' }));
      expect(within(await dialog()).getByText('Closes this request in Prism. Their work stays unsubmitted in Schoology.')).toBeInTheDocument();
    });

    it('Undo of "grade stands" on unsubmitted work says it reopens the request', async () => {
      api.getResubmissions.mockResolvedValue([{ ...HISTORY[0], outcome: 'grade_stands', status: 'closed', closeNote: 'grade stands', ltiState: 'in_progress' }]);
      const panel = await resubPanel();
      fireEvent.click(within(panel).getByRole('button', { name: /^History/ }));
      const history = await screen.findByLabelText('Resubmission history');
      fireEvent.click(await within(history).findByRole('button', { name: 'Undo' }));
      expect(within(await dialog()).getByText('Reopens this request.')).toBeInTheDocument();
    });

    it('Undo of any "grade stands" record says it reopens the request', async () => {
      api.getResubmissions.mockResolvedValue([{ ...HISTORY[0], outcome: 'grade_stands', status: 'closed', closeNote: 'grade stands', ltiState: null }]);
      const panel = await resubPanel();
      fireEvent.click(within(panel).getByRole('button', { name: /^History/ }));
      const history = await screen.findByLabelText('Resubmission history');
      fireEvent.click(await within(history).findByRole('button', { name: 'Undo' }));
      expect(within(await dialog()).getByText('Reopens this request.')).toBeInTheDocument();
    });

    it('a row whose unsubmit was only unconfirmed reads "not confirmed"', async () => {
      const panel = await resubPanel([{ ...RESUB3[2], unsubmitError: "Schoology didn't confirm the unsubmit: x", unsubmitUncertain: true, unsubmitUrl: 'https://s/a' }]);
      expect(within(panel).getByText(/Unsubmit not confirmed/)).toBeInTheDocument();
    });

    it('Undo → Cancel calls no write API', async () => {
      const history = await openHistory();
      fireEvent.click(undoOf(history, 'Ravi Shah'));
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
      for (const fn of SCHOOLOGY_WRITES) expect(api[fn]).not.toHaveBeenCalled();
    });

    it('a record whose action wrote no line (done) undoes directly, Prism-only', async () => {
      const history = await openHistory();
      fireEvent.click(undoOf(history, 'Ivy Lam'));
      await waitFor(() => expect(api.undoResubmission).toHaveBeenCalledWith(52, undefined));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

describe('TriageSection — email (#137)', () => {
  const withEmails = (rows) => rows.map((r) => ({ ...r, studentEmail: `s${r.studentId}@example.test` }));
  const EMAIL_PAYLOAD = {
    ...PAYLOAD,
    lateWork: withEmails(PAYLOAD.lateWork),
    makeUps: withEmails(PAYLOAD.makeUps),
    resubmissions: [
      { id: 31, state: 'waiting', studentId: 11, studentName: 'Ivy Ho', studentEmail: 's11@example.test', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', day: 2, limit: 4, tone: 'green', approx: false, lessons: 3, until: '2026-10-20', source: 'app' },
      { id: null, state: 'arrived', studentId: 12, studentName: 'Jo Ko', studentEmail: 's12@example.test', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', day: 1, limit: 10, tone: 'green', approx: false },
    ],
  };
  beforeEach(() => {
    api.getTriage.mockResolvedValue(EMAIL_PAYLOAD);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('panels carry stable ids for the Dashboard tiles', async () => {
    renderSection();
    await screen.findByText('Maya Chen');
    expect(screen.getByLabelText('Make-up tests')).toHaveAttribute('id', 'triage-makeups');
    expect(screen.getByLabelText('Late work')).toHaveAttribute('id', 'triage-late');
    expect(screen.getByLabelText('Resubmissions')).toHaveAttribute('id', 'triage-resubmissions');
    expect(screen.getByLabelText('Feedback owed')).toHaveAttribute('id', 'triage-feedback');
    expect(within(screen.getByLabelText('Late work')).getByRole('heading', { level: 3 })).toHaveAttribute('tabindex', '-1');
  });

  it('three panels get the @ menu; Feedback owed does not', async () => {
    renderSection();
    await screen.findByText('Maya Chen');
    for (const name of ['Make-up tests', 'Late work', 'Resubmissions']) {
      expect(within(screen.getByLabelText(name)).getByRole('button', { name: 'Copy student emails' })).toBeInTheDocument();
    }
    expect(within(screen.getByLabelText('Feedback owed')).queryByRole('button', { name: 'Copy student emails' })).not.toBeInTheDocument();
  });

  it('Late work menu skips submitted-late rows; Resubmissions menu skips arrived rows', async () => {
    renderSection();
    const late = await latePanel();
    fireEvent.click(within(late).getByRole('button', { name: 'Copy student emails' }));
    // Maya (red, outstanding) + Aiden (green, outstanding); Ethan submitted late → excluded.
    expect(within(late).getAllByRole('menuitem').map((el) => el.textContent))
      .toEqual(['Red (1)', 'Everyone still owing (2)', 'CP2 (1)', 'CP2 · BK 7 (1)']);
    const resub = screen.getByLabelText('Resubmissions');
    fireEvent.click(within(resub).getByRole('button', { name: 'Copy student emails' }));
    expect(within(resub).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Everyone still owing (1)']);
  });

  it('copies every listed student, including rows beyond the 5-row limit', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...PAYLOAD.lateWork[0], studentId: 100 + i, studentName: `Student ${i}`, studentEmail: `p${i}@example.test`,
    }));
    api.getTriage.mockResolvedValue({ ...EMAIL_PAYLOAD, lateWork: many });
    renderSection();
    const late = await latePanel();
    await within(late).findByText('Student 0');
    expect(within(late).queryByText('Student 6')).not.toBeInTheDocument(); // hidden behind "All 7"
    fireEvent.click(within(late).getByRole('button', { name: 'Copy student emails' }));
    await act(async () => { fireEvent.click(within(late).getByRole('menuitem', { name: 'Red (7)' })); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(many.map((r) => r.studentEmail).join('; '));
  });

  it('every row, including arrived and submitted-late, gets a ✉ mailto link', async () => {
    renderSection();
    await screen.findByText('Maya Chen');
    expect(screen.getByRole('link', { name: 'Email Ethan Wong' }))
      .toHaveAttribute('href', 'mailto:s2@example.test?subject=CP2%3A%20late%20work');
    expect(screen.getByRole('link', { name: 'Email Noah Park' }))
      .toHaveAttribute('href', 'mailto:s7@example.test?subject=Unit%201%20test%3A%20make-up%20test');
    expect(screen.getByRole('link', { name: 'Email Jo Ko' }))
      .toHaveAttribute('href', 'mailto:s12@example.test?subject=CP2%3A%20resubmission');
  });

  it('no ✉ on a row without an email', async () => {
    api.getTriage.mockResolvedValue(PAYLOAD); // no studentEmail anywhere
    renderSection();
    await screen.findByText('Maya Chen');
    expect(screen.queryByRole('link', { name: /^Email / })).not.toBeInTheDocument();
  });
});
