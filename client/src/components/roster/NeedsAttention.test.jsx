// Needs attention on the Roster tab (#160): this course's triage rows grouped by student, with the
// rail's own actions. Rendered through RosterTab, so the cards are the real Roster cards.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useParams } from 'react-router-dom';
import RosterTab from './RosterTab.jsx';
import { PrivateDetailsSwitch } from '../PrivateDetails.jsx';
import { setPrivateDetails } from '../../lib/privateDetails.js';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getCourseCommentSummaries: vi.fn(),
  getAlertDetail: vi.fn(),
  getUnreadComments: vi.fn(),
  getEmails: vi.fn(),
  recordReferral: vi.fn(),
  undoReferral: vi.fn(),
  recordExtension: vi.fn(),
  undoExtension: vi.fn(),
  setMakeUpIgnored: vi.fn(),
  updateResubmission: vi.fn(),
  getStatusLineUntil: vi.fn(),
  previewStatusLine: vi.fn(),
  getLessonPlan: vi.fn().mockResolvedValue(null),
}));

const SETTINGS = { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, makeUpAmberDay: 2, makeUpRedDay: 4, showFormativeDefault: false };
const student = (id, first, last, extra = {}) => ({ id, first_name: first, last_name: last, email: `2700${id}@hkis.edu.hk`, grad_year: 2027, ps_alerts: [], dropped_at: null, ...extra });
const STUDENTS = [
  student(1, 'Maya', 'Chen'),
  student(2, 'Ethan', 'Wong'),
  student(3, 'Aiden', 'Li'),
  student(4, 'Noah', 'Park'),
  student(5, 'Zoe', 'Tan'),
  student(6, 'Dee', 'Parted', { dropped_at: '2026-09-01T00:00:00Z' }),
];
const common = (studentId, studentName) => ({ studentId, studentName, studentEmail: `2700${studentId}@hkis.edu.hk`, courseId: 5, courseName: 'AP CSP' });
const OVERDUE_RED = { ...common(1, 'Maya Chen'), kind: 'outstanding', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, day: 10, tone: 'red', approx: false, extension: null };
const LATE_RED = { ...common(2, 'Ethan Wong'), kind: 'submitted_late', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-09-21', daysLate: 10, day: 11, submittedDay: 11, tone: 'red', approx: false, extension: null };
const OVERDUE_GREEN = { ...common(3, 'Aiden Li'), kind: 'outstanding', assignmentId: 10, schoologyAssignmentId: 'a10', title: 'Essay', dueDate: '2026-10-14', daysLate: 2, day: 3, tone: 'green', approx: false, extension: null };
const FLAG = {
  ...common(4, 'Noah Park'), kind: 'flag', flag: 2, exception: 2, firstName: 'Noah', assignmentId: 11, schoologyAssignmentId: 'a11', title: 'Lab report',
  dueDate: '2026-10-05', aligned: true, score: null, advice: 'Set a date to finish, then grade it.', day: 5, limit: 50, tone: 'green', approx: false,
};
const DROPPED = { ...common(6, 'Dee Parted'), kind: 'outstanding', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, day: 10, tone: 'red', approx: false };
const TRIAGE = {
  settings: SETTINGS, lateWork: [OVERDUE_RED, LATE_RED, OVERDUE_GREEN, DROPPED], makeUps: [], resubmissions: [], flags: [FLAG],
  feedbackOwed: [{ assignmentId: 4, schoologyAssignmentId: 'a4', courseId: 5, title: 'Model Card', day: 12, tone: 'red' }], unfinishedGrading: [],
};
const GRADEBOOK = { grades: { 3: { 10: { exception: 3 } } } };

function StudentProbe() { return <p>Student page {useParams().id}</p>; }
function renderTab(props = {}) {
  return render(
    <MemoryRouter initialEntries={['/course/5?mode=attention']}>
      <Routes>
        <Route path="/course/:id" element={(
          <>
            <PrivateDetailsSwitch />
            <RosterTab course={{ id: 5, course_name: 'AP CSP' }} students={STUDENTS} triage={TRIAGE} gradebook={GRADEBOOK} courseId="5" {...props} />
          </>
        )} />
        <Route path="/student/:id" element={<StudentProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}
const cardOf = (name) => screen.getByRole('link', { name }).closest('.roster-card');
const rowOf = (card, title) => within(card).getByRole('link', { name: title }).closest('.roster-attention-row');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); setPrivateDetails(true);
  sessionStorage.clear();
  api.getCourseCommentSummaries.mockResolvedValue({ assignments: {} });
  api.recordReferral.mockResolvedValue({ id: 71, action: 'referred', schoologyMark: null });
  api.undoReferral.mockResolvedValue({ deleted: true });
  api.recordExtension.mockResolvedValue({ id: 81, until: '2026-10-20' });
  api.undoExtension.mockResolvedValue({ deleted: true });
  api.previewStatusLine.mockResolvedValue({ currentComment: '', visible: true, storedLine: null, hiddenWarning: false });
  api.getStatusLineUntil.mockResolvedValue({ until: '2026-10-20', lessons: 3 });
});

describe('Needs attention', () => {
  it('is locked when Private details is off: no row, no count, no name in the page', () => {
    setPrivateDetails(false);
    renderTab();
    expect(screen.getByText('Overdue work, referrals and comments are private.')).toBeInTheDocument();
    expect(screen.queryByText(/Needs attention \(/)).not.toBeInTheDocument();
    expect(screen.queryByText('CP2')).not.toBeInTheDocument();
    expect(screen.queryByText('Maya Chen')).not.toBeInTheDocument();
  });

  it('headings: students with rows, then everyone else; dropped students never count', () => {
    renderTab();
    expect(screen.getByRole('heading', { name: 'Needs attention (4)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Everyone else (1)' })).toBeInTheDocument();
    const names = [...document.querySelectorAll('.roster-card__name')].map((a) => a.textContent);
    // Red rows first, the larger share of the limit first (Ethan 11/8, Maya 10/8), then green (3/8, 5/50).
    expect(names).toEqual(['Ethan Wong', 'Maya Chen', 'Aiden Li', 'Noah Park', 'Zoe Tan']);
    expect(screen.queryByText('Dee Parted')).not.toBeInTheDocument();
    // Feedback owed is Graham's own: not a student's row.
    expect(screen.queryByText('Model Card')).not.toBeInTheDocument();
  });

  it('a row links to the task with the student and the Needs action filter', () => {
    renderTab();
    expect(within(cardOf('Maya Chen')).getByRole('link', { name: 'CP2' }))
      .toHaveAttribute('href', '/course/5/assessment/a9?student=1&filter=action');
  });

  it('each row: the ring in the rail\'s numbers, the kind, and the rail\'s words', () => {
    renderTab();
    const maya = rowOf(cardOf('Maya Chen'), 'CP2');
    expect(within(maya).getByRole('img', { name: '9 school days' })).toBeInTheDocument();
    expect(within(maya).getByText('Overdue')).toBeInTheDocument();
    expect(within(maya).getByText('9 school days late, at the limit')).toBeInTheDocument();
    const aiden = rowOf(cardOf('Aiden Li'), 'Essay');
    expect(within(aiden).getByText('2 school days late, 5 left')).toBeInTheDocument();
    expect(within(rowOf(cardOf('Ethan Wong'), 'CP2')).getByText('Late, handed in')).toBeInTheDocument();
    expect(within(rowOf(cardOf('Noah Park'), 'Lab report')).getByText('Incomplete')).toBeInTheDocument();
  });

  it('overdue work flagged Missing shows the flag beside the kind (from the gradebook)', () => {
    renderTab();
    expect(within(rowOf(cardOf('Aiden Li'), 'Essay')).getByRole('img', { name: 'Flagged Missing in Schoology' })).toBeInTheDocument();
    expect(within(rowOf(cardOf('Maya Chen'), 'CP2')).queryByRole('img', { name: 'Flagged Missing in Schoology' })).not.toBeInTheDocument();
  });

  it('overdue at the limit shows Refer and Extend; late at the limit shows Refer and Waive; a flag row shows FlagsMenu', () => {
    renderTab();
    const buttons = (row) => within(row).getAllByRole('button').map((b) => b.textContent);
    const maya = rowOf(cardOf('Maya Chen'), 'CP2');
    expect(buttons(maya)).toEqual(['Refer', 'Extend']);
    expect(within(maya).getByRole('link', { name: 'Email Maya Chen' })).toHaveAttribute('href', expect.stringMatching(/^mailto:27001@hkis\.edu\.hk\?subject=CP2/));
    expect(buttons(rowOf(cardOf('Ethan Wong'), 'CP2'))).toEqual(['Refer', 'Waive']);
    // Not at the limit: Extend and Email only.
    expect(buttons(rowOf(cardOf('Aiden Li'), 'Essay'))).toEqual(['Extend']);
    const noah = rowOf(cardOf('Noah Park'), 'Lab report');
    expect(within(noah).getByRole('button', { name: /Flag set in Schoology: Incomplete/ })).toHaveAttribute('aria-haspopup', 'menu');
    expect(within(noah).getByRole('link', { name: 'Email Noah Park' })).toBeInTheDocument();
  });

  it('Refer on handed-in work, then Undo, calls the existing APIs and refreshes triage', async () => {
    const onTriageChanged = vi.fn();
    renderTab({ onTriageChanged });
    const ethan = rowOf(cardOf('Ethan Wong'), 'CP2');
    fireEvent.click(within(ethan).getByRole('button', { name: 'Refer' }));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 2, assignmentId: 9, action: 'referred', note: undefined }));
    expect(onTriageChanged).toHaveBeenCalledTimes(1);
    expect(await within(ethan).findByText('Referred')).toBeInTheDocument();
    fireEvent.click(within(ethan).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.undoReferral).toHaveBeenCalledWith(71, { schoology: false }));
    expect(onTriageChanged).toHaveBeenCalledTimes(2);
    expect(await within(ethan).findByRole('button', { name: 'Refer' })).toBeInTheDocument();
  });

  it('Refer on overdue work opens ReferPanel; Undo of a referral that wrote Missing offers to clear it', async () => {
    const onFlagChanged = vi.fn();
    api.recordReferral.mockResolvedValue({ id: 72, action: 'referred', schoologyMark: { missing: true, cleared: false }, schoology: { topics: 2, missing: true } });
    renderTab({ onFlagChanged, onTriageChanged: vi.fn() });
    const maya = rowOf(cardOf('Maya Chen'), 'CP2');
    fireEvent.click(within(maya).getByRole('button', { name: 'Refer' }));
    expect(api.recordReferral).not.toHaveBeenCalled();
    const panel = within(maya).getByRole('group', { name: 'Refer to the academic office?' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Refer' }));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 1, assignmentId: 9, action: 'referred', schoology: true }));
    expect(await within(maya).findByText('Referred')).toBeInTheDocument();
    expect(onFlagChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(within(maya).getByRole('button', { name: 'Undo' }));
    const undo = within(maya).getByRole('group', { name: 'Undo the referral?' });
    fireEvent.click(within(undo).getByRole('button', { name: 'Undo referral' }));
    await waitFor(() => expect(api.undoReferral).toHaveBeenCalledWith(72, { schoology: true }));
    expect(onFlagChanged).toHaveBeenCalledTimes(2);
  });

  // CoursePage's refresh throws when the gradebook read fails: the referral is saved, so the list says
  // the page could not refresh (FlagsMenu's words), and nothing is left as an unhandled rejection.
  it('a failed refresh after a Schoology referral says so, without an unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const onFlagChanged = vi.fn().mockRejectedValue(new Error('Request failed: 500'));
      api.recordReferral.mockResolvedValue({ id: 72, action: 'referred', schoologyMark: { missing: true, cleared: false }, schoology: { topics: 2, missing: true } });
      renderTab({ onFlagChanged, onTriageChanged: vi.fn() });
      const maya = rowOf(cardOf('Maya Chen'), 'CP2');
      fireEvent.click(within(maya).getByRole('button', { name: 'Refer' }));
      fireEvent.click(within(within(maya).getByRole('group', { name: 'Refer to the academic office?' })).getByRole('button', { name: 'Refer' }));
      expect(await within(maya).findByText('Referred')).toBeInTheDocument();
      expect(await screen.findByText('Saved, but the page could not refresh. Reload to see it.')).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a refused referral shows in the panel and records nothing', async () => {
    api.recordReferral.mockRejectedValue(new Error('Schoology holds a score for this work'));
    renderTab({ onTriageChanged: vi.fn() });
    const maya = rowOf(cardOf('Maya Chen'), 'CP2');
    fireEvent.click(within(maya).getByRole('button', { name: 'Refer' }));
    fireEvent.click(within(within(maya).getByRole('group', { name: 'Refer to the academic office?' })).getByRole('button', { name: 'Refer' }));
    expect(await within(maya).findByText('Schoology holds a score for this work')).toBeInTheDocument();
    expect(within(maya).queryByText('Referred')).not.toBeInTheDocument();
  });

  it('Waive records the note', async () => {
    renderTab({ onTriageChanged: vi.fn() });
    const ethan = rowOf(cardOf('Ethan Wong'), 'CP2');
    fireEvent.click(within(ethan).getByRole('button', { name: 'Waive' }));
    fireEvent.change(within(ethan).getByLabelText('Waive note'), { target: { value: 'family emergency' } });
    fireEvent.click(within(ethan).getByRole('button', { name: 'Waive referral' }));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 2, assignmentId: 9, action: 'waived', note: 'family emergency' }));
    expect(await within(ethan).findByText('Referral waived')).toBeInTheDocument();
  });

  it('Extend "From today" on an overdue row reaches the confirm and the write (#201)', async () => {
    renderTab({ onTriageChanged: vi.fn() });
    const aiden = rowOf(cardOf('Aiden Li'), 'Essay');
    fireEvent.click(within(aiden).getByRole('button', { name: 'Extend' }));
    expect(within(aiden).getByRole('button', { name: 'From due date Wed 14/10' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(aiden).getByRole('button', { name: 'From today' }));
    fireEvent.click(within(aiden).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('counted from today');
    await waitFor(() => expect(api.getStatusLineUntil).toHaveBeenCalledWith(expect.objectContaining({ kind: 'extension', countFrom: 'today' })));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish new due date' }));
    await waitFor(() => expect(api.recordExtension).toHaveBeenCalledWith(expect.objectContaining({ studentId: 3, lessons: 3, countFrom: 'today' })));
  });

  it('Extend opens the editor under its row, publishes through the confirm, and Undo removes it', async () => {
    renderTab({ onTriageChanged: vi.fn() });
    const aiden = rowOf(cardOf('Aiden Li'), 'Essay');
    fireEvent.click(within(aiden).getByRole('button', { name: 'Extend' }));
    expect(within(aiden).getByLabelText('Extension (school days)')).toHaveValue(3);
    fireEvent.click(within(aiden).getByRole('button', { name: 'Save' }));
    await screen.findByLabelText('Their comment will read');
    // A tap on the confirm never opens the student page.
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByText(/Student page/)).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish new due date' }));
    await waitFor(() => expect(api.recordExtension).toHaveBeenCalledWith(expect.objectContaining({ studentId: 3, assignmentId: 10, lessons: 3, countFrom: 'due_date' })));
    expect(await within(aiden).findByText('Extended to 20/10/2026')).toBeInTheDocument();

    fireEvent.click(within(aiden).getByRole('button', { name: 'Undo' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.undoExtension).toHaveBeenCalledWith(81, { removeLine: true }));
    await waitFor(() => expect(within(aiden).queryByText('Extended to 20/10/2026')).not.toBeInTheDocument());
  });

  it('a tap among the rows stays on the page; a tap on the card opens the student page', () => {
    renderTab();
    fireEvent.click(within(rowOf(cardOf('Maya Chen'), 'CP2')).getByText('9 school days late, at the limit'));
    expect(screen.queryByText(/Student page/)).not.toBeInTheDocument();
    fireEvent.click(cardOf('Zoe Tan'));
    expect(screen.getByText('Student page 5')).toBeInTheDocument();
  });

  it('says so while triage has not loaded, and on an archived course', () => {
    const { unmount } = renderTab({ triage: null });
    expect(screen.getByText('Reading triage…')).toBeInTheDocument();
    unmount();
    renderTab({ triage: null, course: { id: 5, archived: 1 } });
    expect(screen.getByText('An archived course has no triage.')).toBeInTheDocument();
  });
});
