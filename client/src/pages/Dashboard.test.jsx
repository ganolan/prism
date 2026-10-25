import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard.jsx';
import * as api from '../services/api.js';
import { setPrivateDetails } from '../lib/privateDetails.js';

vi.mock('../services/api.js', () => ({
  getCourses: vi.fn(),
  getCoursesByView: vi.fn(),
  getSyncStatus: vi.fn(),
  toggleCourseVisibility: vi.fn(),
  discoverArchivedCourses: vi.fn(),
  importCourse: vi.fn(),
  getTriage: vi.fn(),
  recordReferral: vi.fn(),
  getReferrals: vi.fn(),
  undoReferral: vi.fn(),
  getMasteryLoginStatus: vi.fn(),
  ensureSync: vi.fn(),
  getCurrentSync: vi.fn(),
  getSyncRun: vi.fn(),
  getSyncRunEvents: vi.fn(),
  getSyncMetrics: vi.fn(),
  startSync: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear(); // Private details reads as on (test-setup.js) unless a test turns it off
  api.getCoursesByView.mockResolvedValue([]);
  api.getCourses.mockResolvedValue([]);
  api.getSyncStatus.mockResolvedValue({});
  api.getTriage.mockResolvedValue(null);
  api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'connected' });
  api.ensureSync.mockResolvedValue({ state: 'fresh' });
  api.getCurrentSync.mockResolvedValue({ running: null, runId: null, queued: [], held: [] });
});

function renderDashboard() {
  return render(<MemoryRouter><Dashboard /></MemoryRouter>);
}

describe('Dashboard — Current tab', () => {
  it('groups current courses by semester, Full Year first then S1 then S2', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'Mobile Game Development', grading_period: 'Semester 2: 01/06/2026 - 06/15/2026' },
      { id: 2, course_name: 'Mobile App Development', grading_period: 'Semester 1: 08/14/2025 - 01/11/2026' },
      { id: 3, course_name: 'AI & Machine Learning', grading_period: '2025-2026: 08/14/2025 - 06/01/2026' },
    ]);
    const { container } = renderDashboard();

    const heads = await screen.findAllByRole('heading', { level: 4 });
    expect(heads.map(h => h.textContent)).toEqual(['Full Year', 'Semester 1', 'Semester 2']);
    heads.forEach(h => expect(h).toHaveClass('semester-subhead'));

    // Cards follow their heading, in the same order
    const labels = [...container.querySelectorAll('h4, .card h3')].map(el => el.textContent);
    expect(labels).toEqual([
      'Full Year', 'AI & Machine Learning',
      'Semester 1', 'Mobile App Development',
      'Semester 2', 'Mobile Game Development',
    ]);
  });

  it('shows the empty state when there are no current courses', async () => {
    renderDashboard();
    expect(await screen.findByText(/No courses yet\. Press/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 4 })).not.toBeInTheDocument();
  });
});

describe('Dashboard — enrolled-student count badge', () => {
  it('shows the enrolment count on a current course card, as plain muted text (not a badge, #137)', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'AI & Machine Learning', student_count: 24 },
    ]);
    renderDashboard();
    const el = await screen.findByText('24 students');
    expect(el).toBeInTheDocument();
    expect(el).not.toHaveClass('badge');
    expect(el).toHaveClass('text-sm', 'text-muted');
  });

  it('says "1 student" when a single student is enrolled', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'Robotics', student_count: 1 },
    ]);
    renderDashboard();
    const el = await screen.findByText('1 student');
    expect(el).toBeInTheDocument();
    expect(el).not.toHaveClass('badge');
  });

  it('omits the badge for empty course shells rather than showing "0 students"', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'Master Template', student_count: 0 },
    ]);
    renderDashboard();
    await screen.findByText('Master Template');
    expect(screen.queryByText(/student/)).not.toBeInTheDocument();
  });

  it('omits the badge when the course carries no student_count at all', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'Mobile App Development' },
    ]);
    renderDashboard();
    await screen.findByText('Mobile App Development');
    expect(screen.queryByText(/student/)).not.toBeInTheDocument();
  });

  it('shows the enrolment count on archived course cards too', async () => {
    api.getCoursesByView.mockImplementation(view =>
      Promise.resolve(view === 'archived'
        ? [{ id: 9, course_name: 'AP CS A', grading_period: '2023-2024: 08/14/2023 - 06/01/2024', student_count: 12 }]
        : [])
    );
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    expect(await screen.findByText('12 students')).toBeInTheDocument();
  });
});

describe('Dashboard — Archived tab', () => {
  it('shows the archived-course discovery surface', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    expect(
      await screen.findByRole('button', { name: /Check Schoology for archived courses/ })
    ).toBeInTheDocument();
  });

  it('no longer renders the manual "Add an archived course" form', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    // wait for the panel (its button) to be present before asserting the form is gone
    await screen.findByRole('button', { name: /Check Schoology for archived courses/ });
    expect(screen.queryByText('Add an archived course')).not.toBeInTheDocument();
    expect(screen.queryByText(/Section ID/)).not.toBeInTheDocument();
  });
});

describe('Dashboard — triage', () => {
  it('shows triage panels and one worst-tone red line on the course card (#137)', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 5, course_name: 'AP Computer Science Principles', grading_period: 'Semester 1: 08/14/2026 - 01/11/2027', student_count: 24 },
    ]);
    api.getTriage.mockResolvedValue({
      settings: { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDay: 2, makeUpRedDay: 4 },
      includeFormative: false, historyCount: 0, lastSyncAt: null, makeUpsUnchecked: 0,
      calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
      lateWork: [{ kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP Computer Science Principles', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, day: 10, tone: 'red', approx: false }],
      feedbackOwed: [{ assignmentId: 4, schoologyAssignmentId: 'a4', courseId: 5, courseName: 'AP Computer Science Principles', title: 'CP1', dueDate: '2026-09-17', aligned: true, owed: 7, submittedTotal: 24, oldestWaitDays: 8, day: 9, tone: 'amber', approx: false }],
      makeUps: [
        { studentId: 2, studentName: 'Noah Park', courseId: 5, courseName: 'AP Computer Science Principles', assignmentId: 20, schoologyAssignmentId: 'q20', title: 'Unit 1 test', dueDate: '2026-10-13', daysSince: 3, day: 4, tone: 'red', approx: false, extension: null },
        { studentId: 3, studentName: 'Zoe Tan', courseId: 5, courseName: 'AP Computer Science Principles', assignmentId: 20, schoologyAssignmentId: 'q20', title: 'Unit 1 test', dueDate: '2026-10-13', daysSince: 1, day: 2, tone: 'amber', approx: false, extension: null },
      ],
    });
    renderDashboard();
    expect(await screen.findByText('Maya Chen')).toBeInTheDocument();
    const card = screen.getByRole('heading', { level: 3, name: 'AP Computer Science Principles' }).closest('.card');
    expect(card).toHaveClass('card--tone-red'); // worst row across the four lists is red (late work, make-up)
    expect(within(card).getByText('1 at limit · 1 make-up')).toHaveClass('course-card__triage');
    expect(within(card).queryByText(/7 to grade · 8 school days waiting/)).not.toBeInTheDocument(); // amber feedback wait stays off the card
    expect(within(card).queryByText('2 make-ups')).not.toBeInTheDocument(); // total make-ups chip is gone; only the red count shows
    expect(card.querySelector('.badge-red, .badge-amber')).toBeNull(); // no chip badges on the card
    expect(await screen.findByText('Noah Park')).toBeInTheDocument();
    expect(screen.getByText('School day 35 of 164 · Day A')).toBeInTheDocument();
  });

  // #197: with Private details off the dashboard keeps the school day and the course cards, and draws
  // no student name, triage line, tone or overdue tile: the rail holds only the shared box.
  it('with Private details off: no name, card line, tone or tile; the school day stays', async () => {
    setPrivateDetails(false);
    api.getCoursesByView.mockResolvedValue([{ id: 5, course_name: 'AP CSP', grading_period: 'Semester 1: 08/14/2026 - 01/11/2027' }]);
    api.getTriage.mockResolvedValue({
      settings: { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDay: 2, makeUpRedDay: 4 },
      includeFormative: false, historyCount: 0, lastSyncAt: null, makeUpsUnchecked: 0, makeUps: [], feedbackOwed: [],
      calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
      counts: { atReferralLimit: 1, makeUpsOverdue: 0, resubmissionsOverdue: 0, feedbackOverdue: 0 },
      lateWork: [{ kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, day: 10, tone: 'red', approx: false }],
    });
    renderDashboard();
    expect(await screen.findByText('School day 35 of 164 · Day A')).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Triage' });
    expect(within(rail).getByText('Triage is private.')).toBeInTheDocument();
    expect(screen.queryByText('Maya Chen')).not.toBeInTheDocument();
    const card = screen.getByRole('heading', { level: 3, name: 'AP CSP' }).closest('.card');
    expect(card).not.toHaveClass('card--tone-red');
    expect(card.querySelector('.course-card__triage')).toBeNull();
    expect(screen.queryByRole('button', { name: /At referral limit/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing overdue')).not.toBeInTheDocument();

    act(() => setPrivateDetails(true));
    expect(await screen.findByText('Maya Chen')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'AP CSP' }).closest('.card')).toHaveClass('card--tone-red');
    expect(screen.getByRole('button', { name: /At referral limit/ })).toBeInTheDocument();
  });

  it('lays the course cards in the main column (2 per row) and the triage rail beside them', async () => {
    api.getCoursesByView.mockResolvedValue([
      { id: 5, course_name: 'AP Computer Science Principles', grading_period: 'Semester 1: 08/14/2026 - 01/11/2027' },
    ]);
    api.getTriage.mockResolvedValue({
      settings: { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDay: 2, makeUpRedDay: 4 },
      includeFormative: false, historyCount: 0, lastSyncAt: null, makeUpsUnchecked: 0, calendar: null,
      lateWork: [], feedbackOwed: [], makeUps: [],
    });
    const { container } = renderDashboard();
    const rail = await screen.findByRole('complementary', { name: 'Triage' });
    const layout = container.querySelector('.triage-layout');
    expect(layout.lastElementChild).toBe(rail); // after the cards: below them on a phone
    const main = layout.querySelector('.triage-layout__main');
    expect(main.querySelector('.grid-2')).toHaveTextContent('AP Computer Science Principles');
    expect([...rail.querySelectorAll('section')].map((el) => el.getAttribute('aria-label')))
      .toEqual(['Make-up tests', 'Overdue work', 'Feedback owed']);
  });

  it('no triage on the Archived tab', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    expect(api.getTriage).toHaveBeenCalledTimes(1); // only the initial Current-tab mount
  });
});

describe('Dashboard — course card tiers (#137)', () => {
  const BASE_TRIAGE = {
    settings: { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDay: 2, makeUpRedDay: 4 },
    includeFormative: false, historyCount: 0, lastSyncAt: null, makeUpsUnchecked: 0, calendar: null,
    lateWork: [], feedbackOwed: [], makeUps: [], resubmissions: [],
  };

  it('an amber-only course gets the amber edge and no red line', async () => {
    api.getCoursesByView.mockResolvedValue([{ id: 20, course_name: 'Amber Only' }]);
    api.getTriage.mockResolvedValue({
      ...BASE_TRIAGE,
      lateWork: [{ courseId: 20, studentId: 1, studentName: 'Amy Lo', title: 'HW1', day: 6, tone: 'amber' }],
    });
    renderDashboard();
    await screen.findByText('Amy Lo'); // waits for the triage fetch (TriageSection) to resolve
    const card = screen.getByText('Amber Only').closest('.card');
    expect(card).toHaveClass('card--tone-amber');
    expect(card).not.toHaveClass('card--tone-red');
    expect(card.querySelector('.course-card__triage')).toBeNull();
  });

  it('a course with nothing outstanding has no tone class', async () => {
    api.getCoursesByView.mockResolvedValue([{ id: 21, course_name: 'Nothing Outstanding' }]);
    api.getTriage.mockResolvedValue(BASE_TRIAGE);
    renderDashboard();
    await screen.findByText('No late summative work.'); // waits for the triage fetch to resolve
    const card = screen.getByText('Nothing Outstanding').closest('.card');
    expect(card).not.toHaveClass('card--tone-red');
    expect(card).not.toHaveClass('card--tone-amber');
    expect(card.querySelector('.course-card__triage')).toBeNull();
  });

  it('a red feedback wait puts "N to grade · D school days waiting" on the card', async () => {
    api.getCoursesByView.mockResolvedValue([{ id: 22, course_name: 'Feedback Only' }]);
    api.getTriage.mockResolvedValue({
      ...BASE_TRIAGE,
      feedbackOwed: [{ courseId: 22, assignmentId: 44, schoologyAssignmentId: 'a44', title: 'CP3', owed: 5, day: 16, tone: 'red' }],
    });
    renderDashboard();
    await screen.findByText('CP3'); // waits for the triage fetch to resolve
    const card = screen.getByText('Feedback Only').closest('.card');
    expect(card).toHaveClass('card--tone-red');
    expect(within(card).getByText('5 to grade · 15 school days waiting')).toHaveClass('course-card__triage');
  });
});

describe('Dashboard — stats strip (#137)', () => {
  const TRIAGE = {
    settings: { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDay: 2, makeUpRedDay: 4 },
    includeFormative: false, historyCount: 0, lastSyncAt: null, makeUpsUnchecked: 0,
    calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
    counts: { atReferralLimit: 2, makeUpsOverdue: 0, resubmissionsOverdue: 1, feedbackOverdue: 3 },
    lateWork: [{ kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, day: 10, tone: 'red', approx: false }],
    feedbackOwed: [], makeUps: [], resubmissions: [],
  };
  beforeEach(() => {
    api.getCoursesByView.mockResolvedValue([{ id: 5, course_name: 'AP CSP', grading_period: 'Semester 1: 08/14/2026 - 01/11/2027' }]);
    api.getTriage.mockResolvedValue(TRIAGE);
    api.getSyncStatus.mockResolvedValue({ last: { completed_at: '2026-10-04 07:12:00', status: 'success' } });
  });
  const strip = () => {
    renderDashboard();
    return screen.findByRole('region', { name: 'At a glance' });
  };

  it('shows only the non-zero tiles, all red (#137)', async () => {
    const s = await strip();
    const tile = (label) => within(s).getByRole('button', { name: new RegExp(label) });
    await within(s).findByRole('button', { name: /At referral limit/ });
    expect(tile('At referral limit')).toHaveTextContent('2');
    expect(tile('At referral limit')).toHaveClass('stat-tile--red');
    expect(within(s).queryByRole('button', { name: /Make-ups overdue/ })).not.toBeInTheDocument(); // 0 → tile hidden
    expect(tile('Resubmissions overdue')).toHaveTextContent('1');
    expect(tile('Resubmissions overdue')).toHaveClass('stat-tile--red');
    expect(tile('Feedback overdue')).toHaveTextContent('3');
    expect(tile('Feedback overdue')).toHaveClass('stat-tile--red');
  });

  it('shows "Nothing overdue" and no tiles when all four counts are 0', async () => {
    api.getTriage.mockResolvedValue({ ...TRIAGE, counts: { atReferralLimit: 0, makeUpsOverdue: 0, resubmissionsOverdue: 0, feedbackOverdue: 0 }, lateWork: [] });
    const s = await strip();
    expect(await within(s).findByText('Nothing overdue')).toHaveClass('stats-strip__clear');
    expect(within(s).queryByRole('button')).not.toBeInTheDocument();
  });

  it('a tile scrolls its panel into view and focuses the panel heading', async () => {
    const s = await strip();
    await screen.findByText('Maya Chen');
    const panel = document.getElementById('triage-late');
    panel.scrollIntoView = vi.fn();
    fireEvent.click(await within(s).findByRole('button', { name: /At referral limit/ }));
    expect(panel.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(within(panel).getByRole('heading', { level: 3 })).toHaveFocus();
  });

  it('a tile whose panel is not rendered does nothing', async () => {
    const s = await strip();
    await screen.findByText('Maya Chen');
    expect(document.getElementById('triage-resubmissions')).toBeNull(); // empty Resubmissions hides itself
    const tile = await within(s).findByRole('button', { name: /Resubmissions overdue/ });
    expect(() => fireEvent.click(tile)).not.toThrow();
  });

  it('status line: school day, last sync, Schoology connection', async () => {
    const s = await strip();
    await within(s).findByText('School day 35 of 164 · Day A');
    expect(within(s).getByText(/^Last sync .*, success$/)).toBeInTheDocument();
    expect(await within(s).findByText('Schoology: connected')).toBeInTheDocument();
    expect(screen.queryByText(/Last sync: /)).not.toBeInTheDocument(); // the old standalone line is gone
  });

  it('an expired Schoology connection links to Settings', async () => {
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'expired' });
    const s = await strip();
    expect(await within(s).findByRole('link', { name: 'Schoology: expired' })).toHaveAttribute('href', '/settings#schoology');
  });

  it('no strip on the Archived tab', async () => {
    await strip();
    fireEvent.click(screen.getByText('Archived'));
    expect(screen.queryByRole('region', { name: 'At a glance' })).not.toBeInTheDocument();
  });
});

describe('Dashboard — background sync', () => {
  it('asks the queue to sync every current course; shows the oldest course\'s time', async () => {
    const recent = new Date().toISOString();
    api.getCoursesByView.mockResolvedValue([
      { id: 1, course_name: 'A', course_synced_at: recent },
      { id: 2, course_name: 'B', course_synced_at: '2026-10-18T19:00:00.000Z' },
    ]);
    renderDashboard();
    expect(await screen.findByText(/^19\/10\/2026 at|^18\/10\/2026 at|^\d{1,2}:\d\d [AP]M today$/)).toBeInTheDocument();
    expect(api.ensureSync).toHaveBeenCalledWith({ kind: 'all' });
    expect(screen.queryByText(/^\d{1,2}:\d\d [AP]M today$/)).toBeNull(); // the oldest, not the newest
  });

  it('a help "?" beside the sync time, and the nightly line beneath it, amber when the night was missed', async () => {
    api.getCoursesByView.mockResolvedValue([{ id: 1, course_name: 'A', course_synced_at: new Date().toISOString() }]);
    api.getSyncStatus.mockResolvedValue({ nightlyData: { readAt: new Date(Date.now() - 50 * 3600 * 1000).toISOString(), nightly: false } });
    renderDashboard();
    const dot = await screen.findByRole('img', { name: /Press Sync Courses only if you changed something in Schoology just now\./ });
    expect(dot).toHaveAttribute('aria-label', expect.stringContaining('Blocks, calendar and alerts: refreshed when you press Sync Courses.'));
    expect(screen.getByText('2 days old').closest('.sync-status__row')).toHaveClass('sync-status__row--stale');
  });

  it('final review #8: the "?" is there when the sync status cannot be read (nightly taken as off)', async () => {
    api.getCoursesByView.mockResolvedValue([{ id: 1, course_name: 'A', course_synced_at: new Date().toISOString() }]);
    api.getSyncStatus.mockRejectedValue(new Error('Prism is restarting'));
    renderDashboard();
    const dot = await screen.findByRole('img', { name: /Press Sync Courses only if you changed something in Schoology just now\./ });
    expect(dot).toHaveAttribute('aria-label', expect.stringContaining('Blocks, calendar and alerts: refreshed when you press Sync Courses.'));
  });

  it('with Show hidden on, an excluded template is neither shown nor counted in the sync time (#171)', async () => {
    const recent = new Date().toISOString();
    api.getCourses.mockResolvedValue([
      { id: 1, course_name: 'Real Course', archived: 0, hidden: 0, course_synced_at: recent },
      { id: 2, course_name: 'Hidden Course', archived: 0, hidden: 1, course_synced_at: recent },
      { id: 3, course_name: 'Template', archived: 0, hidden: 0, excluded: 1, course_synced_at: null },
    ]);
    renderDashboard();
    fireEvent.click(await screen.findByRole('switch', { name: 'Show hidden' }));
    await waitFor(() => expect(api.getCourses).toHaveBeenCalledWith(true, true));
    expect(await screen.findByText('Hidden Course')).toBeInTheDocument();
    expect(screen.getByText('Real Course')).toBeInTheDocument();
    expect(screen.queryByText('Template')).toBeNull();
    expect(screen.getByText(/^\d{1,2}:\d\d [AP]M today$/)).toBeInTheDocument();
    expect(screen.queryByText('none yet')).toBeNull();
  });

  it('Sync Courses on the Current tab is one click: it posts { everything: true } and shows the progress', async () => {
    api.getCoursesByView.mockResolvedValue([{ id: 1, course_name: 'A', course_synced_at: new Date().toISOString() }]);
    api.startSync.mockResolvedValue({ runId: 7, state: 'queued', joined: false });
    api.getSyncRunEvents.mockResolvedValue({ status: 'running', finished: false, events: [] });
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Courses' }));
    await waitFor(() => expect(api.startSync).toHaveBeenCalledWith({ everything: true }));
    expect(await screen.findByText('Syncing…', { selector: 'h2, h3, .sync-progress-head *' })).toBeInTheDocument();
    expect(screen.queryByText(/Each ticked course/)).toBeNull();
  });
});

describe('Dashboard: the Archived tab', () => {
  it('has the help "?" (past courses are not refreshed) but no nightly line and no button', async () => {
    api.getSyncStatus.mockResolvedValue({ nightlyData: { readAt: null, nightly: true } });
    api.getCoursesByView.mockImplementation(async (view) => (view === 'archived'
      ? [{ id: 4, course_name: 'Archived Bio', hidden: 0, archived: 1, course_synced_at: '2026-06-18T03:02:00.000Z' }] : []));
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Archived Bio')).toBeInTheDocument();
    expect(await screen.findByRole('img', {
      name: 'Prism does not refresh past courses automatically. Open a course and press Sync Course to read it again.',
    })).toBeInTheDocument();
    expect(screen.queryByText('Blocks, calendar and alerts')).toBeNull();
  });

  it('has no Sync Courses button, and still shows its sync time', async () => {
    api.getCoursesByView.mockImplementation(async (view) => (view === 'archived'
      ? [{ id: 4, course_name: 'Archived Bio', hidden: 0, archived: 1, course_synced_at: '2026-06-18T03:02:00.000Z' }] : []));
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Archived Bio')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync Courses' })).toBeNull();
    expect(screen.getByText('Last successful sync')).toBeInTheDocument();
  });
});

describe('Dashboard: the first run (#171)', () => {
  const course = (id, more = {}) => ({ id, course_name: `Course ${id}`, grading_period: 'Semester 1: 08/14/2026 - 01/11/2027', ...more });
  // 12 current courses (8 still pending, 3 read, 1 failed) and an excluded template, pending.
  const firstRunCourses = () => [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((id) => course(id, { first_sync: 'pending' })),
    course(9), course(10), course(11),
    course(12, { first_sync: 'failed', first_sync_error: 'Schoology answered 500' }),
    course(13, { excluded: 1, first_sync: 'pending' }),
  ];
  afterEach(() => { vi.useRealTimers(); });
  const runGoing = () => {
    api.ensureSync.mockResolvedValue({ state: 'queued', runId: 5 });
    api.getCurrentSync.mockResolvedValue({ running: { runId: 5 }, runId: 5, queued: [], held: [] });
  };

  it('hides pending courses and counts the finished ones: "Getting your courses: 4 of 12"', async () => {
    runGoing();
    api.getCoursesByView.mockResolvedValue(firstRunCourses());
    renderDashboard();
    expect(await screen.findByText('Getting your courses: 4 of 12')).toBeInTheDocument();
    expect(screen.getByText('Course 9')).toBeInTheDocument();
    expect(screen.queryByText('Course 1')).toBeNull();
    expect(screen.queryByText('Course 8')).toBeNull();
  });

  it('a course whose first read failed shows with a "Sync failed" badge and links to its page', async () => {
    api.getCoursesByView.mockResolvedValue([course(9), course(12, { first_sync: 'failed', first_sync_error: 'Schoology API 500' })]);
    renderDashboard();
    const card = (await screen.findByText('Course 12')).closest('a');
    expect(card).toHaveAttribute('href', '/course/12');
    expect(within(card).getByText('Sync failed')).toHaveClass('badge', 'badge-red');
    expect(within(card).getByText('Sync failed')).toHaveAttribute('title', 'Schoology API 500'); // the first read's error
    expect(within(screen.getByText('Course 9').closest('a')).queryByText('Sync failed')).toBeNull();
    expect(screen.queryByText(/Getting your courses/)).toBeNull(); // none pending: no line
  });

  it('the sync time ignores pending courses', async () => {
    const recent = new Date().toISOString();
    api.getCoursesByView.mockResolvedValue([course(1, { course_synced_at: recent }), course(2, { first_sync: 'pending' })]);
    renderDashboard();
    expect(await screen.findByText(/^\d{1,2}:\d\d [AP]M today$/)).toBeInTheDocument();
  });

  it('re-fetches the courses every 3 seconds while any is pending, and stops when none is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runGoing();
    api.getCoursesByView
      .mockResolvedValueOnce([course(1, { first_sync: 'pending' }), course(2)])
      .mockResolvedValueOnce([course(1, { first_sync: 'pending' }), course(2)])
      .mockResolvedValue([course(1), course(2)]);
    renderDashboard();
    expect(await screen.findByText('Getting your courses: 1 of 2')).toBeInTheDocument();
    const calls = api.getCoursesByView.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(api.getCoursesByView).toHaveBeenCalledTimes(calls + 1);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(api.getCoursesByView).toHaveBeenCalledTimes(calls + 2);
    expect(await screen.findByText('Course 1')).toBeInTheDocument();
    expect(screen.queryByText(/Getting your courses/)).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(api.getCoursesByView).toHaveBeenCalledTimes(calls + 2);
  });

  // Pending rows can outlive their run (the server was stopped mid-run): with no run going they are
  // not "being read", so they show as cards with "Sync failed", and nothing polls.
  it.each([
    ['done', () => {
      api.ensureSync.mockResolvedValue({ state: 'queued', runId: 5 });
      api.getSyncRun.mockResolvedValue({ status: 'completed' });
    }],
    ['failed', () => { api.ensureSync.mockResolvedValue({ state: 'failed', runId: 5 }); }],
  ])('pending courses with the background run %s: shown with "Sync failed", no line, no polling', async (_, setUp) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setUp();
    api.getCoursesByView.mockResolvedValue([course(1, { first_sync: 'pending' }), course(2)]);
    renderDashboard();
    const card = (await screen.findByText('Course 1')).closest('a');
    expect(card).toHaveAttribute('href', '/course/1');
    expect(within(card).getByText('Sync failed')).toHaveClass('badge', 'badge-red');
    // #172: never tried (no error), so the badge says so rather than carrying an empty title.
    expect(within(card).getByText('Sync failed')).toHaveAttribute('title', 'Not read yet');
    await waitFor(() => expect(api.getCoursesByView.mock.calls.length).toBeGreaterThan(0));
    await act(() => vi.advanceTimersByTimeAsync(100)); // the run's end reloads once
    const calls = api.getCoursesByView.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(api.getCoursesByView).toHaveBeenCalledTimes(calls);
    expect(screen.queryByText(/Getting your courses/)).toBeNull();
  });

  it('final review #7: a failed reload after the run ends still shows the pending course as "Sync failed"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let going = true;
    api.ensureSync.mockResolvedValue({ state: 'queued', runId: 5 });
    api.getCurrentSync.mockImplementation(async () => (going
      ? { running: { runId: 5 }, runId: 5, queued: [], held: [] } : { running: null, runId: null, queued: [], held: [] }));
    api.getSyncRun.mockResolvedValue({ status: 'interrupted' });
    const listed = [course(1, { first_sync: 'pending' }), course(2)];
    api.getCoursesByView.mockResolvedValueOnce(listed).mockResolvedValueOnce(listed)
      .mockRejectedValue(new Error('Prism is restarting'));
    renderDashboard();
    expect(await screen.findByText('Getting your courses: 1 of 2')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3000)); // a poll lists the courses while the run goes
    await waitFor(() => expect(api.getCoursesByView).toHaveBeenCalledTimes(2));
    going = false;
    await act(() => vi.advanceTimersByTimeAsync(2500)); // the run's end is seen; its reload fails
    const card = (await screen.findByText('Course 1')).closest('a');
    expect(within(card).getByText('Sync failed')).toBeInTheDocument();
    expect(screen.queryByText(/Getting your courses/)).toBeNull();
    error.mockRestore();
  });

  it('a late poll answer never lands on the other tab', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runGoing();
    let answerLate;
    api.getCoursesByView
      .mockResolvedValueOnce([course(1, { first_sync: 'pending' }), course(2)])
      .mockImplementationOnce(() => new Promise((resolve) => { answerLate = resolve; }))
      .mockImplementation(async (view) => (view === 'archived'
        ? [{ id: 50, course_name: 'Past 1', archived: 1, grading_period: '2023-2024: 08/14/2023 - 06/01/2024' }] : []));
    renderDashboard();
    await screen.findByText('Getting your courses: 1 of 2');
    await act(() => vi.advanceTimersByTimeAsync(3000)); // the poll goes out and waits
    expect(answerLate).toBeTypeOf('function');
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Past 1')).toBeInTheDocument();
    await act(async () => { answerLate([course(1), course(2)]); });
    expect(screen.queryByText('Course 2')).toBeNull();
    expect(screen.getByText('Past 1')).toBeInTheDocument();
  });

  it('no courses and a run held for a sign-in: the empty state says so beside the chip', async () => {
    api.ensureSync.mockResolvedValue({ state: 'held', runId: 5 });
    api.getCurrentSync.mockResolvedValue({ running: null, runId: null, queued: [], held: [{ runId: 5 }] });
    renderDashboard();
    expect(await screen.findByText('Your courses appear here once you log in to Schoology.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in to Schoology' })).toBeInTheDocument();
    expect(screen.queryByText(/No courses yet/)).toBeNull();
  });

  it('no courses and a run going: "Getting your courses…"', async () => {
    api.ensureSync.mockResolvedValue({ state: 'queued', runId: 5 });
    api.getCurrentSync.mockResolvedValue({ running: { runId: 5 }, runId: 5, queued: [], held: [] });
    renderDashboard();
    expect(await screen.findByText('Getting your courses…')).toBeInTheDocument();
    expect(screen.queryByText(/No courses yet/)).toBeNull();
  });

  it('no courses while the first run goes: the list is fetched every 3 seconds until its courses appear', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runGoing();
    api.getCoursesByView.mockResolvedValueOnce([]).mockResolvedValue([course(1, { first_sync: 'pending' }), course(2)]);
    renderDashboard();
    expect(await screen.findByText('Getting your courses…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(await screen.findByText('Getting your courses: 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Course 2')).toBeInTheDocument();
  });

  it('no courses and nothing running: "No courses yet. Press Sync Courses to get your courses."', async () => {
    renderDashboard();
    const copy = 'No courses yet. Press Sync Courses to get your courses.';
    expect(await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === copy)).toBeInTheDocument();
  });
});

describe('Dashboard: the past-course import on the Archived tab (#171)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const archived = (n) => Array.from({ length: n }, (_, i) => ({
    id: 100 + i, course_name: `Past ${i + 1}`, archived: 1, grading_period: '2023-2024: 08/14/2023 - 06/01/2024',
  }));

  it('shows "Importing past courses: 7 of 30", polls every 5 seconds and reloads the courses when done changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let done = 7;
    api.getSyncStatus.mockImplementation(async () => ({ pastImport: { state: 'importing', done, total: 30 } }));
    api.getCoursesByView.mockImplementation(async (view) => (view === 'archived' ? archived(done) : []));
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Importing past courses: 7 of 30')).toBeInTheDocument();
    expect(await screen.findByText('Past 7')).toBeInTheDocument();
    const statusCalls = api.getSyncStatus.mock.calls.length;
    const archivedCalls = () => api.getCoursesByView.mock.calls.filter(([v]) => v === 'archived').length;
    const before = archivedCalls();

    await act(() => vi.advanceTimersByTimeAsync(5000)); // same count: no reload
    expect(api.getSyncStatus).toHaveBeenCalledTimes(statusCalls + 1);
    expect(archivedCalls()).toBe(before);

    done = 8;
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(api.getSyncStatus).toHaveBeenCalledTimes(statusCalls + 2);
    expect(await screen.findByText('Importing past courses: 8 of 30')).toBeInTheDocument();
    expect(await screen.findByText('Past 8')).toBeInTheDocument();
    expect(archivedCalls()).toBe(before + 1);
  });

  it('checks every 5 seconds while the import waits to start during a run, and shows the line once it imports', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.ensureSync.mockResolvedValue({ state: 'queued', runId: 5 });
    api.getCurrentSync.mockResolvedValue({ running: { runId: 5 }, runId: 5, queued: [], held: [] });
    api.getSyncStatus.mockResolvedValue({ pastImport: { state: 'waiting', done: 0, total: 0 } });
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    await screen.findByRole('button', { name: /Check Schoology for archived courses/ });
    expect(screen.queryByText(/Importing past courses/)).toBeNull();
    api.getSyncStatus.mockResolvedValue({ pastImport: { state: 'importing', done: 0, total: 30 } });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText('Importing past courses: 0 of 30')).toBeInTheDocument();
  });

  it('does not check while the import waits with no run going (the run\'s end reloads the status)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getSyncStatus.mockResolvedValue({ pastImport: { state: 'waiting', done: 0, total: 0 } });
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    await screen.findByRole('button', { name: /Check Schoology for archived courses/ });
    const calls = api.getSyncStatus.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(api.getSyncStatus).toHaveBeenCalledTimes(calls);
  });

  it('final review #1: the run ends while the import still waits; the status is checked on, and the line appears', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let going = true;
    api.ensureSync.mockResolvedValue({ state: 'queued', runId: 5 });
    api.getCurrentSync.mockImplementation(async () => (going
      ? { running: { runId: 5 }, runId: 5, queued: [], held: [] } : { running: null, runId: null, queued: [], held: [] }));
    api.getSyncRun.mockResolvedValue({ status: 'completed' });
    api.getSyncStatus.mockResolvedValue({ pastImport: { state: 'waiting', done: 0, total: 0 } });
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    await screen.findByRole('button', { name: /Check Schoology for archived courses/ });
    going = false;
    await act(() => vi.advanceTimersByTimeAsync(2500)); // the run ends; the status still says waiting
    expect(screen.queryByText(/Importing past courses/)).toBeNull();
    // The discovery finishes: no data version moves, the next check finds it importing.
    api.getSyncStatus.mockResolvedValue({ pastImport: { state: 'importing', done: 0, total: 12 } });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText('Importing past courses: 0 of 12')).toBeInTheDocument();
  });

  it('final review #1: after the run ends, a waiting import is checked for 2 minutes, then no more', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let going = true;
    api.ensureSync.mockResolvedValue({ state: 'queued', runId: 5 });
    api.getCurrentSync.mockImplementation(async () => (going
      ? { running: { runId: 5 }, runId: 5, queued: [], held: [] } : { running: null, runId: null, queued: [], held: [] }));
    api.getSyncRun.mockResolvedValue({ status: 'completed' });
    api.getSyncStatus.mockResolvedValue({ pastImport: { state: 'waiting', done: 0, total: 0 } });
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    await screen.findByRole('button', { name: /Check Schoology for archived courses/ });
    going = false;
    await act(() => vi.advanceTimersByTimeAsync(2500)); // the run ends
    const atEnd = api.getSyncStatus.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(api.getSyncStatus.mock.calls.length).toBeGreaterThanOrEqual(atEnd + 11);
    await act(() => vi.advanceTimersByTimeAsync(65_000)); // past the 2 minutes
    const after = api.getSyncStatus.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(api.getSyncStatus).toHaveBeenCalledTimes(after);
  });

  it('final review #1: switching from Current to Archived reads the status again and shows the import', async () => {
    api.getSyncStatus.mockResolvedValue({ pastImport: { state: 'waiting', done: 0, total: 0 } });
    renderDashboard();
    await screen.findByRole('button', { name: 'Archived' });
    await waitFor(() => expect(api.getSyncStatus).toHaveBeenCalled());
    api.getSyncStatus.mockResolvedValue({ pastImport: { state: 'importing', done: 2, total: 12 } });
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Importing past courses: 2 of 12')).toBeInTheDocument();
  });

  it('stops polling when the user leaves the tab', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getSyncStatus.mockResolvedValue({ pastImport: { state: 'importing', done: 7, total: 30 } });
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    await screen.findByText('Importing past courses: 7 of 30');
    fireEvent.click(screen.getByRole('button', { name: 'Current' }));
    const calls = api.getSyncStatus.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(api.getSyncStatus).toHaveBeenCalledTimes(calls);
  });

  it.each(['done', 'none'])('no line when the import is %s', async (state) => {
    api.getSyncStatus.mockResolvedValue({ pastImport: { state, done: 30, total: 30 } });
    api.getCoursesByView.mockImplementation(async (view) => (view === 'archived' ? archived(1) : []));
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Past 1')).toBeInTheDocument();
    expect(screen.queryByText(/Importing past courses/)).toBeNull();
  });
});
