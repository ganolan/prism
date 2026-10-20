import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard.jsx';
import * as api from '../services/api.js';

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
      .toEqual(['Make-up tests', 'Late work', 'Feedback owed']);
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
    expect(await screen.findByText(/^Synced 19\/10\/2026|^Synced 18\/10\/2026|^Synced \d\d:\d\d today$/)).toBeInTheDocument();
    expect(api.ensureSync).toHaveBeenCalledWith({ kind: 'all' });
    expect(screen.queryByText(/^Synced \d\d:\d\d today$/)).toBeNull(); // the oldest, not the newest
  });

  it('a help "?" beside the Synced time, and the nightly line beneath it, amber when the night was missed', async () => {
    api.getCoursesByView.mockResolvedValue([{ id: 1, course_name: 'A', course_synced_at: new Date().toISOString() }]);
    api.getSyncStatus.mockResolvedValue({ nightlyData: { readAt: new Date(Date.now() - 50 * 3600 * 1000).toISOString(), nightly: false } });
    renderDashboard();
    const dot = await screen.findByRole('img', { name: /Press Sync Courses only if you changed something in Schoology just now\./ });
    expect(dot).toHaveAttribute('aria-label', expect.stringContaining('Blocks, calendar and alerts: refreshed when you press Sync Courses.'));
    expect(screen.getByText('Blocks, calendar and alerts: 2 days old. Press Sync Courses to refresh them.')).toHaveClass('sync-status__nightly--stale');
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
  it('has the help "?" but no nightly line and no button', async () => {
    api.getSyncStatus.mockResolvedValue({ nightlyData: { readAt: null, nightly: true } });
    api.getCoursesByView.mockImplementation(async (view) => (view === 'archived'
      ? [{ id: 4, course_name: 'Archived Bio', hidden: 0, archived: 1, course_synced_at: '2026-06-18T03:02:00.000Z' }] : []));
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Archived Bio')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /Press Sync Courses only if/ })).toBeInTheDocument();
    expect(screen.queryByText(/Blocks, calendar and alerts: not read yet/)).toBeNull();
  });

  it('has no Sync Courses button, and still shows its Synced time', async () => {
    api.getCoursesByView.mockImplementation(async (view) => (view === 'archived'
      ? [{ id: 4, course_name: 'Archived Bio', hidden: 0, archived: 1, course_synced_at: '2026-06-18T03:02:00.000Z' }] : []));
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Archived Bio')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync Courses' })).toBeNull();
    expect(screen.getByText(/^Synced /)).toBeInTheDocument();
  });
});
