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
}));

const SETTINGS = {
  referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDays: 1, makeUpRedDays: 3,
};
const PAYLOAD = {
  settings: SETTINGS, includeFormative: false, historyCount: 2, lastSyncAt: '2026-10-01 07:42:00', makeUpsUnchecked: 0,
  calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
  lateWork: [
    { kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, tone: 'red', approx: false },
    { kind: 'submitted_late', studentId: 2, studentName: 'Ethan Wong', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-09-21', daysLate: 10, submittedOn: '2026-10-05', tone: 'red', approx: false },
    { kind: 'outstanding', studentId: 3, studentName: 'Aiden Li', courseId: 6, courseName: 'AP CSP', blockNumber: '7', assignmentId: 10, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-14', daysLate: 2, tone: 'green', approx: false, extension: { id: 4, lessons: 3, until: '2026-10-15', note: null } },
  ],
  feedbackOwed: [
    { assignmentId: 4, schoologyAssignmentId: 'a4', courseId: 6, courseName: 'AP CSP', blockNumber: '7', title: 'Model Card', dueDate: '2026-09-14', aligned: true, owed: 18, submittedTotal: 22, oldestWaitDays: 11, tone: 'red', approx: false },
  ],
  makeUps: [
    { studentId: 7, studentName: 'Noah Park', courseId: 8, courseName: 'AP CSP', blockNumber: '3', assignmentId: 20, schoologyAssignmentId: 'q20', title: 'Unit 1 test', dueDate: '2026-10-13', daysSince: 3, tone: 'red', approx: false, extension: null },
    { studentId: 8, studentName: 'Zoe Tan', courseId: 5, courseName: 'AP CSP', assignmentId: 21, schoologyAssignmentId: 'q21', title: 'Unit 2 quiz', dueDate: '2026-10-15', daysSince: 0, tone: 'green', approx: false, extension: { id: 9, lessons: 2, until: '2026-10-20', note: 'sits Tue' } },
  ],
};
const latePanel = async () => screen.findByLabelText('Late work');
const makeUpPanel = async () => screen.findByLabelText('Make-up tests');

function renderSection(props = {}) {
  return render(<MemoryRouter><TriageSection {...props} /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getTriage.mockResolvedValue(PAYLOAD);
  api.recordReferral.mockResolvedValue({ id: 1 });
  api.recordExtension.mockResolvedValue({ id: 2 });
  api.getReferrals.mockResolvedValue([]);
  api.getExtensions.mockResolvedValue([]);
  api.setMakeUpIgnored.mockResolvedValue({ assignmentId: 20, title: 'Unit 1 test', ignored: true });
});

describe('TriageSection', () => {
  it('renders both panels with counts, tags and course chips (all-courses view)', async () => {
    renderSection();
    expect(await screen.findByText('Maya Chen')).toBeInTheDocument();
    expect(screen.getByText('2 at referral limit')).toBeInTheDocument();
    expect(screen.getByText('submitted day 10')).toBeInTheDocument();
    expect(screen.getByText('6 left')).toBeInTheDocument();
    expect(screen.getByText('18 of 22 ungraded')).toBeInTheDocument();
    expect(screen.getAllByText('AP CSP').length).toBeGreaterThan(0);
    expect(screen.getAllByText('[BK 7] AP CSP')).toHaveLength(2); // one late row + one feedback row
    expect(screen.getByText('ext +3 → 15/10/2026')).toBeInTheDocument();
    expect(screen.getByText(/Referred \/ extended \(2\)/)).toBeInTheDocument();
    expect(screen.getByText('Summative work late or submitted after the limit · school days since due · refer at 8')).toBeInTheDocument();
  });

  it('hides course chips on a course page and passes courseId', async () => {
    renderSection({ courseId: 5 });
    await screen.findByText('Maya Chen');
    expect(api.getTriage).toHaveBeenCalledWith({ courseId: 5, includeFormative: undefined });
    expect(screen.queryByText('AP CSP')).not.toBeInTheDocument();
    expect(screen.queryByText('[BK 7] AP CSP')).not.toBeInTheDocument();
  });

  it('Mark referred posts and reloads', async () => {
    renderSection();
    fireEvent.click((await screen.findAllByText('Mark referred'))[0]);
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 1, assignmentId: 9, action: 'referred', note: undefined }));
    expect(api.getTriage).toHaveBeenCalledTimes(2);
  });

  it('every row offers Extend; Mark referred only on red rows; no Exempt', async () => {
    renderSection();
    expect(within(await latePanel()).getAllByText('Extend')).toHaveLength(3);
    expect(screen.getAllByText('Mark referred')).toHaveLength(2);
    expect(screen.queryByText('Exempt')).not.toBeInTheDocument();
  });

  it('Extend posts N lessons (default 3) and a note, then reloads', async () => {
    renderSection();
    fireEvent.click(within(await latePanel()).getAllByText('Extend')[0]); // Maya: no extension yet
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
    fireEvent.click(within(await latePanel()).getAllByText('Extend')[2]); // Aiden
    expect(screen.getByLabelText('Extension (lessons)')).toHaveValue(5);
    expect(screen.getByLabelText('Extension note')).toHaveValue('trip');
  });

  it('Extend → Cancel closes the editor without posting', async () => {
    renderSection();
    fireEvent.click(within(await latePanel()).getAllByText('Extend')[0]);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByLabelText('Extension (lessons)')).not.toBeInTheDocument();
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

  it('history rows show the block; a failed undo shows the error inline', async () => {
    api.getReferrals.mockResolvedValue([
      { id: 3, action: 'referred', daysLate: 9, createdAt: '2026-10-01 07:42:00', studentName: 'Maya Chen', courseName: 'AP CSP', blockNumber: '7', title: 'CP2', note: null },
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
      { id: 3, action: 'referred', daysLate: 9, createdAt: '2026-10-01 07:42:00', studentName: 'Maya Chen', courseName: 'AP CSP', title: 'CP2', note: null },
    ]);
    api.getExtensions.mockResolvedValue([
      { id: 7, lessons: 3, until: '2026-10-15', createdAt: '2026-10-02 01:00:00', studentName: 'Aiden Li', courseName: 'AP CSP', title: 'CP2', note: 'sick' },
    ]);
    api.undoExtension.mockResolvedValue({ deleted: true });
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('Extended +3 → 15/10/2026')).toBeInTheDocument();
    expect(within(history).getByText('Referred · day 9')).toBeInTheDocument();
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
      { id: 3, action: 'referred', daysLate: 9, createdAt: '2026-10-01 07:42:00', studentName: 'Maya Chen', courseName: 'AP CSP', title: 'CP2', note: null },
    ]);
    api.getExtensions.mockRejectedValue(new Error('boom'));
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    const history = await screen.findByLabelText('Referral history');
    expect(await within(history).findByText('Referred · day 9')).toBeInTheDocument();
    expect(within(history).getByText(/Couldn't load extensions: boom/)).toBeInTheDocument();
  });

  it('an open history reloads after Mark referred', async () => {
    renderSection();
    fireEvent.click(await screen.findByText(/Referred \/ extended \(2\)/));
    await waitFor(() => expect(api.getReferrals).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByText('Mark referred')[0]);
    await waitFor(() => expect(api.getReferrals).toHaveBeenCalledTimes(2));
  });
});

describe('TriageSection — make-up tests', () => {
  it('renders full-width above the late-work and feedback panels', async () => {
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
    expect(within(panel).getByText('Missed Schoology tests and quizzes · school days since the test · sit by day 3')).toBeInTheDocument();
    expect(within(panel).getByText('[BK 3] AP CSP')).toBeInTheDocument();
    expect(within(panel).getByText('Noah Park')).toBeInTheDocument();
    expect(within(panel).getByText('Unit 1 test')).toBeInTheDocument();
    expect(within(panel).getByRole('img', { name: '3 of 3 school days' })).toBeInTheDocument();
    expect(within(panel).getByText('ext +2 → 20/10/2026')).toBeInTheDocument();
    expect(within(panel).getAllByText('Extend')).toHaveLength(2);
    expect(within(panel).queryByText('Mark referred')).not.toBeInTheDocument();
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
    fireEvent.click(within(panel).getAllByText('Extend')[1]); // Zoe: ext +2, "sits Tue"
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
    fireEvent.click(within(panel).getAllByText('Ignore this test')[0]); // Noah's Unit 1 test
    expect(within(panel).getByText('Ignore Unit 1 test for all students?')).toBeInTheDocument();
    fireEvent.click(within(panel).getByText('Yes'));
    await waitFor(() => expect(api.setMakeUpIgnored).toHaveBeenCalledWith(20, true));
    await waitFor(() => expect(api.getTriage).toHaveBeenCalledTimes(2));
    expect(onMakeUpIgnored).toHaveBeenCalledWith(20);
  });

  it('Cancel leaves it tracked', async () => {
    renderSection();
    const panel = await makeUpPanel();
    fireEvent.click(within(panel).getAllByText('Ignore this test')[0]);
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
