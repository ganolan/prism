// Student page: every task is the shared grade card (#176), read-only, with Edit and Done in place
// on a course Prism can write. The cards come from GET /api/students/:id/grade-cards, one request
// per expanded course (this student's data only). The card is shown in a meeting: no portrait and
// no AI suggestion. This student's OneDrive "Open" links and submission comment and file chips
// load after the page renders.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';

// Each course's mastery summary, recorded (its reloadKey says when it reloads).
const summary = vi.hoisted(() => vi.fn(() => null));
vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: (props) => summary(props) }));
// Edit mode's draft saver: tests assert wiring, not I/O.
vi.mock('../lib/assessmentDraftSaver.js', () => ({
  makeDraftSaver: vi.fn(() => ({ save: vi.fn(), remove: vi.fn(), flush: vi.fn(), settle: vi.fn(async () => {}), dispose: vi.fn() })),
}));
vi.mock('../services/api.js', async (orig) => ({
  ...(await orig()),
  getStudent: vi.fn(),
  getGradeCards: vi.fn(),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getRubricConfig: vi.fn().mockResolvedValue({ reportingCategoryColors: {} }),
  getStudentWorkLinks: vi.fn(),
  getStudentCommentSummaries: vi.fn(),
  getStudentFileSummaries: vi.fn().mockResolvedValue({ assignments: {}, refresh: { queued: 0 } }),
  getFeedbackForAssignment: vi.fn().mockResolvedValue({}),
  getSettings: vi.fn().mockResolvedValue({ triage: { resubmitLessonsDefault: 4 } }),
  getTriagePair: vi.fn().mockResolvedValue(null),
  writeMasteryComment: vi.fn().mockResolvedValue({}),
  getProficiencyScale: vi.fn().mockResolvedValue({
    schoologyScaleId: 21337256,
    levels: [
      { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
      { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
      { code: 'D', label: 'Developing', points: 50, gradeScaled: '37.50' },
      { code: 'EM', label: 'Emerging', points: 25, gradeScaled: '12.50' },
      { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
    ],
  }),
}));

import StudentPage, { CourseSection } from './StudentPage.jsx';
import { draftBaseline } from '../lib/assessmentDraft.js';
import { setPrivateDetails } from '../lib/privateDetails.js';
import {
  getStudent, getGradeCards, getStudentWorkLinks, getStudentCommentSummaries,
  getStudentFileSummaries, getFeedbackForAssignment, writeMasteryComment,
} from '../services/api.js';

// ── Card fixtures, in the shape GET /api/students/:id/grade-cards returns ───────────────────────
const TOPICS = [{ id: 't1', title: 'Select, analyze', external_id: 'ART.5.1', category_title: 'HS Art: Producing' }];
const RUBRIC = {
  id: 1,
  rubric: { criteria: [{ id: 'c1', position: 1, criterion_name: 'UI/UX',
    descriptors: { ED: 'Polished and intuitive.', EX: 'Clear and usable.', D: 'Inconsistent.', EM: 'Hard to use.' } }] },
  topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }],
};
const ROWS_RUBRIC = {
  id: 2, topicByCriterion: [],
  rubric: { criteria: [{ id: 'c9', position: 1, criterion_name: 'Playtesting', standard_title: 'Refine work',
    descriptors: { ED: 'Iterates from evidence.', EX: 'Tests and fixes.', D: 'Tests once.', EM: 'No testing.' } }] },
};
const SCALE = {
  name: 'General Academic Scale',
  levels: [
    { code: 'ED', label: 'Exhibiting Depth', points: 100 },
    { code: 'EX', label: 'Exhibiting', points: 75 },
    { code: 'D', label: 'Developing', points: 50 },
    { code: 'EM', label: 'Emerging', points: 25 },
    { code: 'IE', label: 'Insufficient Evidence', points: 0 },
  ],
};
const PICTURE = 'https://example.test/ada.jpg';
const LINK = { url: 'https://hkis-my.sharepoint.com/f.pptx?d=w1', fileName: 'f.pptx', modifiedAt: '2026-10-01T01:00:00Z' };
const WRITABLE = { id: 1, archived: 0, excluded: 0, writable: true };

const cardAssignment = (over = {}) => ({
  id: 10, schoology_assignment_id: 'sa-10', course_id: 1, title: 'Portfolio', due_date: '2026-04-12',
  max_points: 100, grading_scale_id: null, accepts_submissions: 1, is_test: 0, is_lti_submission: 0,
  mastery_grading_period_id: 1, mastery_grading_category_id: 2, ...over,
});
const cardStudent = (over = {}) => ({
  id: 7, schoology_uid: 'u1', enrollment_id: 'e1', first_name: 'Ada', last_name: 'Lovelace',
  preferred_name: null, preferred_name_teacher: null, picture_url: PICTURE,
  scores: { t1: { grade: 'EX' } }, grade_comment: 'Strong reflection.', comment_status: 1, exception: 0,
  score: 75, submission_type: 'drop', submitted_at: 1, late: 0, draft: 0, timeline: null,
  attention: { handedIn: true, reasons: [] }, row_levels: {}, scale_level: null, saved_grade: null, ...over,
});
const makeCard = ({ assignment = {}, student = {}, topics = TOPICS, scoreScale = null, rubric = null, draft = null, hasDraft = false } = {}) => ({
  assignment: cardAssignment(assignment), topics, scoreScale, student: cardStudent(student), rubric, draft, hasDraft,
});

// The student page's own grade row (GET /api/students/:id), which lists the tasks.
const grade = (over = {}) => ({
  course_id: 1, assignment_id: 10, schoology_assignment_id: 'sa-10', assignment_title: 'Portfolio',
  due_date: '2026-04-12', score: 75, assignment_max_points: 100, exception: 0, late: 0, draft: 0,
  submitted_at: 1, submission_type: 'drop', grading_scale_id: null, mastery: { topics: [] },
  grade_comment: 'Strong reflection.', ...over,
});

function renderSection(grades, cards, { course = WRITABLE, ...props } = {}) {
  getGradeCards.mockResolvedValue({ course, cards });
  return render(
    <MemoryRouter>
      <CourseSection course={{ id: 1, course_name: 'Art', archived: course.archived, excluded: course.excluded }} grades={grades}
        studentUid="u1" scales={{}} studentId={7} {...props} />
    </MemoryRouter>
  );
}
const one = (opts) => ({ 'sa-10': makeCard(opts) });
const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => vi.clearAllMocks());

describe('CourseSection: every task is the grade card (#176)', () => {
  it('shows an attached rubric\'s descriptors with the awarded level, comment below', async () => {
    renderSection([grade()], one({ rubric: RUBRIC }));
    const awarded = (await screen.findByText('Clear and usable.')).closest('td');
    expect(awarded).toHaveAttribute('data-awarded', 'true');
    expect(follows(awarded, screen.getByText('Strong reflection.'))).toBe(true);
    expect(getGradeCards).toHaveBeenCalledWith(7, { courseId: 1 });
  });

  it('without an attached rubric shows the topic grid', async () => {
    renderSection([grade()], one());
    expect(await screen.findByText('Measurement Topic')).toBeInTheDocument();
    expect(screen.queryByText('Clear and usable.')).not.toBeInTheDocument();
  });

  it('the task title heads the card and links to the assessment page; the status pill comes before the rubric', async () => {
    renderSection([grade()], one());
    const title = await screen.findByRole('link', { name: 'Portfolio' });
    expect(title).toHaveAttribute('href', '/course/1/assessment/sa-10');
    const pill = screen.getByText('Submitted');
    expect(follows(title, pill)).toBe(true);
    expect(follows(pill, screen.getByText('Select, analyze'))).toBe(true);
  });

  it('an unaligned task\'s title links to its /assessment/ page too, as in the gradebook (#41)', async () => {
    renderSection([grade({ grading_scale_id: '7165818', mastery: null })], one({ topics: [], student: { score: 100, scores: {} } }));
    expect(await screen.findByRole('link', { name: 'Portfolio' })).toHaveAttribute('href', '/course/1/assessment/sa-10');
  });

  it('a points-only task shows its score in the rubric\'s place', async () => {
    renderSection([grade()], one({ topics: [], student: { score: 50, scores: {} } }));
    expect(await screen.findByText('50 / 100')).toBeInTheDocument();
    expect(screen.getByText('Score:')).toBeInTheDocument();
    expect(screen.getByText('Strong reflection.')).toBeInTheDocument();
  });

  it('a points-only task on a named grading scale shows the level name (the page\'s grading_scales)', async () => {
    const scales = { 77: { levels: [{ name: 'Meets', average: 50 }, { name: 'Exceeds', average: 100 }] } };
    renderSection([grade()], one({ topics: [], assignment: { grading_scale_id: 77 }, student: { score: 50, scores: {} } }), { scales });
    expect(await screen.findByText('Meets')).toBeInTheDocument();
    expect(screen.queryByText('50 / 100')).not.toBeInTheDocument();
  });

  it('an unaligned task with a rubric shows its feedback rows and the overall level', async () => {
    renderSection([grade()], one({
      topics: [], scoreScale: SCALE, rubric: ROWS_RUBRIC,
      student: { scores: {}, row_levels: { Playtesting: 'EX' }, scale_level: 'EX' },
    }));
    expect((await screen.findByText('Tests and fixes.')).closest('td')).toHaveAttribute('data-awarded', 'true');
    const overall = screen.getByRole('group', { name: 'General Academic Scale' });
    expect(within(overall).getByRole('button', { pressed: true })).toHaveTextContent('Exhibiting');
  });

  it('the timeline shows the due date, when the work came in and how late, with its own "?"', async () => {
    const timeline = {
      due: { date: '2026-10-06', time: '15:00' }, extension: null, deadline: '2026-10-06',
      submission: { state: 'submitted', firstAt: Math.floor(new Date('2026-10-12T09:00:00').getTime() / 1000), latestAt: null, late: true, day: 4, lateMinutes: null, schoologyLate: true },
      overdue: null, resubmission: null, referral: null, limit: 8,
    };
    renderSection([grade({ timeline })], one({ student: { timeline } }));
    const row = await screen.findByTestId('submission-timeline');
    expect(row).toHaveTextContent('Due 06/10 15:00');
    expect(row).toHaveTextContent('Submitted 12/10 09:00 (3 school days late)');
    expect(screen.getAllByRole('img', { name: /school days after the due date/ })).toHaveLength(1);
    // The timeline carries the due date, so the raw "Due: " text is not drawn as well.
    expect(screen.queryByText(/Due: /)).not.toBeInTheDocument();
  });

  it('a task whose student has not resubmitted shows no Resubmitted pill', async () => {
    renderSection([grade()], one());
    await screen.findByText('Portfolio');
    expect(screen.queryByText('Resubmitted')).not.toBeInTheDocument();
  });

  it('a resubmission that has arrived reads Resubmitted; an open request shows its chip', async () => {
    renderSection([grade(), grade({ assignment_id: 11, schoology_assignment_id: 'sa-11', assignment_title: 'Essay' })], {
      'sa-10': makeCard({ student: { resubmitted: true } }),
      'sa-11': makeCard({ assignment: { id: 11, schoology_assignment_id: 'sa-11', title: 'Essay' },
        student: { attention: { handedIn: true, reasons: [{ id: 'resubmission_pending', until: '2026-10-28', tone: 'green' }] } } }),
    });
    expect(await screen.findByText('Resubmitted')).toBeInTheDocument();
    expect(screen.getByText('Resubmission due 28/10')).toHaveAttribute('data-reason', 'resubmission_pending');
  });

  it('an Overdue task shows its attention chip', async () => {
    renderSection([grade()], one({
      assignment: { due_date: '2026-04-12' },
      student: { score: null, scores: {}, submission_type: null, submitted_at: 0, grade_comment: '',
        attention: { handedIn: false, reasons: [{ id: 'late', daysLate: 3, tone: 'red' }] } },
    }));
    expect(await screen.findByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Late, 3 school days')).toHaveAttribute('data-reason', 'late');
  });

  it('a current draft shows the draft mark and its chip; nothing of the draft itself is drawn', async () => {
    renderSection([grade()], one({ hasDraft: true, draft: { base: 'x', pending: { t1: 'ED' }, comment: 'Unsaved words.' } }));
    expect(await screen.findByText('● Draft - not published')).toBeInTheDocument();
    expect(screen.getByText('Draft not published')).toHaveAttribute('data-reason', 'draft');
    expect(screen.queryByText('Unsaved words.')).not.toBeInTheDocument();
  });
});

describe('CourseSection: Missing shows IE (#40)', () => {
  it('no topic levels: IE with the Missing symbol on every topic, and the line saying why', async () => {
    renderSection([grade()], one({ student: { exception: 3, score: null, scores: {} } }));
    const cell = (await screen.findByText('Select, analyze')).closest('tr').querySelectorAll('td')[5];
    expect(cell).toHaveTextContent('IE');
    expect(within(cell).getByRole('img', { name: 'Missing' })).toBeInTheDocument();
    expect(screen.getByText('Shown as IE because the work is marked Missing. Schoology holds no topic levels for this task yet.')).toBeInTheDocument();
  });

  it('with topic levels, they show as they are under the other line', async () => {
    renderSection([grade()], one({ rubric: RUBRIC, student: { exception: 3 } }));
    expect((await screen.findByText('Clear and usable.')).closest('td')).toHaveAttribute('data-awarded', 'true');
    expect(screen.getByText('Marked Missing. These levels still count in the topic averages.')).toBeInTheDocument();
  });
});

describe('CourseSection: this student\'s links', () => {
  it('shows the OneDrive Open link and the comments chip in the card\'s header', async () => {
    renderSection([grade({ score: null })], one(), {
      workLinks: { 'sa-10': LINK },
      commentSummaries: { 'sa-10': { count: 2, student_text: true, read_at: '2026-10-17T02:00:00.000Z' } },
    });
    const open = await screen.findByRole('link', { name: "Open Ada Lovelace's work in OneDrive" });
    expect(open).toHaveAttribute('href', LINK.url);
    const chip = screen.getByRole('button', { name: /2 submission comments, the student wrote text/ });
    const header = screen.getByText('Submitted').closest('.status-pill-wrap').parentElement.parentElement;
    expect(header).toContainElement(open);
    expect(header).toContainElement(chip);
  });

  it('shows the files chip for a native upload, after the Open link and before the comments chip (#162)', async () => {
    const onFileSummary = vi.fn();
    renderSection([grade({ score: null })], one(), {
      workLinks: { 'sa-10': LINK }, onFileSummary,
      fileSummaries: { 'sa-10': { revisions: 2, files: 3, read_at: '2026-10-17T02:00:00.000Z' } },
      commentSummaries: { 'sa-10': { count: 2, read_at: '2026-10-17T02:00:00.000Z' } },
    });
    const files = await screen.findByRole('button', { name: 'Submitted files: 3 files in 2 revisions. Open the list' });
    expect(files).toHaveTextContent('3 files');
    expect(follows(screen.getByRole('link', { name: /work in OneDrive/ }), files)).toBe(true);
    expect(follows(files, screen.getByRole('button', { name: /2 submission comments/ }))).toBe(true);
  });

  it('a never-read upload shows a plain Files chip; none on OneDrive work, a test, no upload, or with the feature off', async () => {
    const { unmount } = renderSection([grade()], one(), { fileSummaries: {} });
    expect(await screen.findByRole('button', { name: 'Submitted files: not read yet. Open the list' })).toHaveTextContent('Files');
    unmount();
    const none = [
      grade({ is_lti_submission: 1, assignment_id: 11, schoology_assignment_id: 'sa-11' }),
      grade({ is_test: 1, submission_type: 'assessment', assignment_id: 12, schoology_assignment_id: 'sa-12' }),
      grade({ submission_type: null, assignment_id: 13, schoology_assignment_id: 'sa-13' }),
    ];
    const again = renderSection(none, {
      'sa-11': makeCard({ assignment: { id: 11, schoology_assignment_id: 'sa-11', is_lti_submission: 1 } }),
      'sa-12': makeCard({ assignment: { id: 12, schoology_assignment_id: 'sa-12', is_test: 1 }, student: { submission_type: 'assessment' } }),
      'sa-13': makeCard({ assignment: { id: 13, schoology_assignment_id: 'sa-13' }, student: { submission_type: null } }),
    }, { fileSummaries: {} });
    expect(await screen.findAllByText('Select, analyze')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Submitted files/ })).not.toBeInTheDocument();
    again.unmount();
    renderSection([grade()], one(), { fileSummaries: null });
    expect(await screen.findByText('Select, analyze')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submitted files/ })).not.toBeInTheDocument();
  });

  it('no comments chip while the feature is off, nor on a task the student never touched', async () => {
    const { unmount } = renderSection([grade()], one(), { commentSummaries: null });
    expect(await screen.findByText('Select, analyze')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submission comment/ })).not.toBeInTheDocument();
    unmount();
    renderSection([grade({ score: null, submitted_at: 0, submission_type: null })], one(), { commentSummaries: {} });
    expect(await screen.findByText('Select, analyze')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submission comment/ })).not.toBeInTheDocument();
  });

  it('shows an Attempt link on a test task, keyed by Schoology assignment id; none without one', async () => {
    const { unmount } = renderSection([grade()], one(), {
      attemptLinks: { 'sa-10': { url: 'https://schoology.hkis.edu.hk/assignment/9/assessment_results/student_stats/u/2', completedAt: '2026-10-09 09:31' } },
    });
    expect(await screen.findByRole('link', { name: "Attempt: open Ada Lovelace's test attempt in Schoology" }))
      .toHaveAttribute('href', expect.stringContaining('/student_stats/u/2'));
    unmount();
    renderSection([grade()], one(), { attemptLinks: { other: { url: 'https://x.example/a' } } });
    expect(await screen.findByText('Select, analyze')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /test attempt/i })).not.toBeInTheDocument();
  });
});

describe('CourseSection: loading and errors', () => {
  it('while the cards load, each task shows its title and "Loading…"', async () => {
    getGradeCards.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <CourseSection course={{ id: 1, course_name: 'Art' }} grades={[grade()]} studentUid="u1" scales={{}} studentId={7} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'Portfolio' })).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('a failed load says so, and the titles stay', async () => {
    getGradeCards.mockRejectedValue(new Error('Prism is restarting'));
    render(
      <MemoryRouter>
        <CourseSection course={{ id: 1, course_name: 'Art' }} grades={[grade()]} studentUid="u1" scales={{}} studentId={7} />
      </MemoryRouter>
    );
    const alert = await screen.findByText('Could not load the grades for this course. Reload the page.');
    expect(alert).toHaveClass('alert', 'alert-warning');
    expect(screen.getByRole('link', { name: 'Portfolio' })).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('a collapsed course asks for nothing', async () => {
    renderSection([grade()], one());
    await screen.findByText('Select, analyze');
    fireEvent.click(screen.getByRole('button', { name: /Art/ }));
    expect(screen.queryByText('Select, analyze')).not.toBeInTheDocument();
    expect(getGradeCards).toHaveBeenCalledTimes(1);
  });

  it('collapsing a course leaves edit mode; opened again, its cards are read again', async () => {
    renderSection([grade()], one());
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Art/ }));
    getGradeCards.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Art/ }));
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await waitFor(() => expect(getGradeCards).toHaveBeenCalledWith(7, { courseId: 1 }));
  });
});

// #40 flags, and #176 Edit: only where Prism can write the course.
describe('CourseSection: flags and Edit follow course.writable', () => {
  it('on a writable course: a Flags menu and an Edit button on each task', async () => {
    renderSection([grade()], one());
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Flags/ })).toBeInTheDocument();
  });

  it.each([
    ['archived', { id: 1, archived: 1, excluded: 0, writable: false }],
    ['excluded', { id: 1, archived: 0, excluded: 1, writable: false }],
    ['linked', { id: 1, archived: 0, excluded: 0, writable: false }],
  ])('no Edit and no Flags on an %s course: the read-only card stays', async (_, course) => {
    renderSection([grade()], one({ rubric: RUBRIC }), { course });
    expect(await screen.findByText('Clear and usable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Flags/ })).not.toBeInTheDocument();
  });

  it('a flagged points task: the symbol\'s popover names the saved grade', async () => {
    renderSection([grade()], one({
      topics: [],
      student: { score: null, scores: {}, exception: 1, flag_line: 'Marked exempt on Wed 21/10.',
        saved_grade: { summary: '75 / 100', savedAt: '2026-10-21 02:00:00', topics: {} } },
    }));
    await screen.findByText('Score:');
    fireEvent.mouseEnter(screen.getAllByRole('img', { name: 'Exempt' }).at(-1));
    const pop = screen.getByRole('tooltip');
    expect(pop).toHaveTextContent('Grade saved in Prism: 75 / 100. Clear the flag to restore it.');
    expect(pop).toHaveTextContent('Marked exempt on Wed 21/10.');
  });

  it('a publish in place shows as published at once, before the task\'s own read comes back', async () => {
    renderSection([grade()], one());
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = await screen.findByRole('textbox');
    getGradeCards.mockReturnValue(new Promise(() => {})); // the read after the publish never lands
    fireEvent.change(box, { target: { value: 'Regraded after our meeting.' } });
    expect(screen.getByText('● Draft - not published')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Schoology' }));
    await waitFor(() => expect(writeMasteryComment).toHaveBeenCalledWith(1, expect.objectContaining({ assignmentId: 'sa-10', comment: 'Regraded after our meeting.' })));
    expect(await screen.findByText('✓ Published to Schoology')).toBeInTheDocument();
    expect(screen.queryByText('● Draft - not published')).not.toBeInTheDocument();
    expect(getGradeCards).toHaveBeenLastCalledWith(7, { courseId: 1, assignmentId: 'sa-10' });
  });

  it('the student page never shows a portrait or a suggestion, in view or edit mode', async () => {
    renderSection([grade()], one({ rubric: RUBRIC }));
    await screen.findByText('Clear and usable.');
    const shown = () => ({
      photo: document.querySelector(`img[src="${PICTURE}"]`) != null,
      initials: screen.queryByText((_, el) => el.tagName === 'DIV' && el.textContent === 'AL') != null,
      suggested: screen.queryAllByText(/Suggested/).length > 0,
      notes: screen.queryAllByText('Reviewer notes').length > 0,
      sparkles: screen.queryAllByTestId('ai-sparkle').length > 0,
    });
    const none = { photo: false, initials: false, suggested: false, notes: false, sparkles: false };
    expect(shown()).toEqual(none);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(shown()).toEqual(none);
    expect(getFeedbackForAssignment).not.toHaveBeenCalled();
  });
});

describe('StudentPage', () => {
  const student = {
    id: 7, first_name: 'Ada', last_name: 'Lovelace', schoology_uid: 'u1',
    courses: [{ id: 1, course_name: 'Art' }, { id: 2, course_name: 'Design' }],
    grades: [
      grade(),
      grade({ course_id: 2, assignment_id: 20, schoology_assignment_id: 'sa-20', assignment_title: 'Poster', is_lti_submission: 1 }),
      grade({ course_id: 2, assignment_id: 21, schoology_assignment_id: 'sa-21', assignment_title: 'Quiz', mastery: null }),
      ...[22, 23, 24].map((n) => grade({ course_id: 2, assignment_id: n, schoology_assignment_id: `sa-${n}`, assignment_title: `Deck ${n}`, mastery: null, is_lti_submission: 1 })),
    ],
    notes: [], flags: [], parents: [], grading_scales: {},
  };
  // Each course's cards, built from the page's own grade rows.
  const cardsFor = (courseId, only = null) => Object.fromEntries(student.grades
    .filter((g) => g.course_id === courseId && (only == null || g.schoology_assignment_id === only))
    .map((g) => [g.schoology_assignment_id, makeCard({
      assignment: { id: g.assignment_id, schoology_assignment_id: g.schoology_assignment_id, course_id: courseId, title: g.assignment_title, is_lti_submission: g.is_lti_submission ? 1 : 0 },
      topics: courseId === 1 ? TOPICS : [],
      rubric: g.schoology_assignment_id === 'sa-10' ? RUBRIC : null,
    })]));
  const serveCards = (makeOne = (c) => c) => getGradeCards.mockImplementation(async (id, { courseId, assignmentId } = {}) => ({
    course: { id: courseId, archived: 0, excluded: 0, writable: true },
    cards: Object.fromEntries(Object.entries(cardsFor(courseId, assignmentId ?? null)).map(([aid, c]) => [aid, makeOne(c, { courseId, assignmentId })])),
  }));
  const renderPage = () => render(
    <MemoryRouter initialEntries={['/student/7']}>
      <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
    </MemoryRouter>
  );
  beforeEach(() => {
    getStudent.mockResolvedValue(student);
    getStudentWorkLinks.mockResolvedValue({ links: {}, status: {} });
    getStudentCommentSummaries.mockResolvedValue({ assignments: {}, refresh: { queued: 0 } });
    serveCards();
  });

  // Graham, 27 Oct 2026: grades and feedback are not private on the student page; the notes still are.
  it('with Private details off, every course shows its grade cards, levels and comments; notes are left out', async () => {
    getStudent.mockResolvedValue({ ...student, notes: [{ id: 1, content: 'Left early for the dentist', created_at: '2026-10-01' }] });
    setPrivateDetails(false);
    try {
      const { container } = renderPage();
      expect(await screen.findByText('Clear and usable.')).toBeInTheDocument(); // the awarded level
      expect(screen.getAllByText('Strong reflection.').length).toBeGreaterThan(0); // the comment
      expect(screen.getByRole('link', { name: 'Art' })).toBeInTheDocument();
      expect(await screen.findByRole('link', { name: 'Deck 24' })).toBeInTheDocument();
      expect(screen.getByText('Alerts, family contacts and notes are private.')).toBeInTheDocument();
      expect(screen.queryByText(/^Notes$/)).not.toBeInTheDocument();
      expect(container.textContent).not.toMatch(/dentist/);
    } finally {
      setPrivateDetails(true);
    }
  });

  it('asks for each course\'s grade cards once, for this student; no class-wide or per-task request', async () => {
    renderPage();
    expect(await screen.findByText('Clear and usable.')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Deck 24' })).toBeInTheDocument();
    await waitFor(() => expect(getGradeCards).toHaveBeenCalledTimes(2));
    expect(getGradeCards).toHaveBeenCalledWith(7, { courseId: 1 });
    expect(getGradeCards).toHaveBeenCalledWith(7, { courseId: 2 });
  });

  it('renders first, then fills in OneDrive links a few assignments at a time, and reads this student\'s comments', async () => {
    let releaseFirst;
    getStudentWorkLinks
      .mockImplementationOnce(() => new Promise((r) => { releaseFirst = () => r({ links: { 'sa-20': LINK, 'sa-22': null }, status: {} }); }))
      .mockResolvedValueOnce({ links: { 'sa-24': { ...LINK, url: 'https://hkis-my.sharepoint.com/g.pptx?d=w2' } }, status: {} });
    getStudentCommentSummaries.mockResolvedValue({ assignments: { 'sa-10': { count: 1, read_at: '2026-10-17T02:00:00.000Z' } }, refresh: { queued: 0 } });
    renderPage();
    // The page is up while the first lookup is still running.
    // (The title moves into the card's header when the cards arrive: look it up again each time.)
    await waitFor(() => expect(screen.getByRole('link', { name: 'Poster' })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /work in OneDrive/ })).not.toBeInTheDocument();
    // The lookup starts in an effect after the first render: wait for it (a slow CI
    // runner reached this line first, 19/10/2026).
    await waitFor(() => expect(getStudentWorkLinks).toHaveBeenCalledTimes(1));
    expect(getStudentWorkLinks).toHaveBeenCalledWith(7, ['sa-20', 'sa-22', 'sa-23']);
    releaseFirst();
    await waitFor(() => expect(screen.getAllByRole('link', { name: "Open Ada Lovelace's work in OneDrive" })).toHaveLength(2));
    expect(getStudentWorkLinks).toHaveBeenLastCalledWith(7, ['sa-24']);
    expect(getStudentCommentSummaries).toHaveBeenCalledWith(7, { refresh: true });
    expect(await screen.findByRole('button', { name: /1 submission comment\b/ })).toBeInTheDocument();
  });

  it('reads this student\'s file chips after the page renders, then once more when a background read was queued', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getStudentFileSummaries
        .mockResolvedValueOnce({ assignments: {}, refresh: { queued: 1 } })
        .mockResolvedValueOnce({ assignments: { 'sa-10': { revisions: 1, files: 2, read_at: '2026-10-17T02:00:00.000Z' } }, refresh: null });
      renderPage();
      // Portfolio and Quiz take uploads; the OneDrive tasks get no files chip.
      expect(await screen.findAllByRole('button', { name: 'Submitted files: not read yet. Open the list' })).toHaveLength(2);
      expect(getStudentFileSummaries).toHaveBeenCalledWith(7, { refresh: true });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await screen.findByRole('button', { name: 'Submitted files: 2 files in 1 revision. Open the list' })).toBeInTheDocument();
      expect(getStudentFileSummaries).toHaveBeenLastCalledWith(7, { refresh: false });
    } finally { vi.useRealTimers(); }
  });

  it('Edit refetches the task; Done reloads the course', async () => {
    // The task's draft as the server holds it at the moment Edit is pressed (saved elsewhere since
    // the page loaded): edit mode must start from it.
    serveCards((c, { assignmentId }) => (assignmentId ? {
      ...c, hasDraft: true,
      draft: { base: draftBaseline(c.student, c.topics, { includeScore: false }), pending: {}, comment: 'Saved on the laptop.', display: true, displayTouched: false },
    } : c));
    renderPage();
    await screen.findByText('Clear and usable.');
    await waitFor(() => expect(getGradeCards).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await waitFor(() => expect(getGradeCards).toHaveBeenCalledWith(7, { courseId: 1, assignmentId: 'sa-10' }));
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Saved on the laptop.');
    // Only this task is in edit mode.
    expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBe(5);
    expect(getStudent).toHaveBeenCalledTimes(1);

    getGradeCards.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    await waitFor(() => expect(getStudent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getGradeCards).toHaveBeenCalledWith(7, { courseId: 1 }));
    expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBe(6);
  });

  // The latest reloadKey each course's mastery summary was drawn with.
  const summaryKey = (courseId) => summary.mock.calls.filter(([p]) => p.courseId === courseId).at(-1)?.[0].reloadKey;

  it('Done reloads the student and only the edited course\'s summary and cards', async () => {
    renderPage();
    await screen.findByText('Clear and usable.');
    await waitFor(() => expect(getGradeCards).toHaveBeenCalledTimes(2));
    const before = { 1: summaryKey(1), 2: summaryKey(2) };
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(getStudent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getGradeCards).toHaveBeenLastCalledWith(7, { courseId: 1 }));
    await waitFor(() => expect(summaryKey(1)).toBeGreaterThan(before[1]));
    expect(getGradeCards.mock.calls.filter(([, o]) => o.courseId === 2 && o.assignmentId == null)).toHaveLength(1);
    expect(summaryKey(2)).toBe(before[2]);
  });

  it('two tasks can be open for editing at once', async () => {
    renderPage();
    await screen.findByText('Clear and usable.');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(6));
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await screen.findByRole('button', { name: 'Done' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Done' })).toHaveLength(2));
    expect(screen.getAllByPlaceholderText(/Teacher comment for this student/)).toHaveLength(2);
    // One of the two is the points-only task: its edit card has the points box (#181).
    expect(screen.getAllByRole('textbox', { name: 'Score:' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(4);
  });

  it('Edit pressed again while Done\'s reload is in flight starts from the newer draft', async () => {
    const draftOf = (c, comment) => ({
      ...c, hasDraft: true,
      draft: { base: draftBaseline(c.student, c.topics, { includeScore: false }), pending: {}, comment, display: true, displayTouched: false },
    });
    let serverComment = 'First draft.';
    const held = [];
    const hold = () => new Promise((resolve) => held.push(resolve));
    let holdReads = false;
    getGradeCards.mockImplementation(async (id, { courseId, assignmentId } = {}) => {
      const answer = () => ({
        course: { id: courseId, archived: 0, excluded: 0, writable: true },
        cards: Object.fromEntries(Object.entries(cardsFor(courseId, assignmentId ?? null))
          .map(([aid, c]) => [aid, aid === 'sa-10' && assignmentId ? draftOf(c, serverComment) : c])),
      });
      if (!holdReads) return answer();
      await hold();
      return answer();
    });
    renderPage();
    await screen.findByText('Clear and usable.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    expect(await screen.findByRole('textbox')).toHaveValue('First draft.');

    // Done: the student is read again, then the course reloads; both are slow.
    let releaseStudent;
    getStudent.mockImplementationOnce(() => new Promise((r) => { releaseStudent = () => r(student); }));
    holdReads = true;
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    await waitFor(() => expect(getStudent).toHaveBeenCalledTimes(2));
    // Meanwhile the draft changed on the server (saved on another device), and Edit is pressed again.
    serverComment = 'Newer draft.';
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await waitFor(() => expect(held).toHaveLength(1)); // Edit's own read of the task
    releaseStudent();
    await waitFor(() => expect(held).toHaveLength(2)); // the course reload, issued after Edit's read
    held[0](); // Edit's read lands first; the reload is still in flight
    expect(await screen.findByRole('textbox')).toHaveValue('Newer draft.');
    held[1]();
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Newer draft.'));
  });

  it('another student\'s page opens with every task read-only, even with a task in edit mode here', async () => {
    getStudent.mockImplementation(async (id) => (String(id) === '8'
      ? { ...student, id: 8, first_name: 'Bea', schoology_uid: 'u8' } : student));
    function GoToB() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/student/8')}>Go to Bea</button>;
    }
    render(
      <MemoryRouter initialEntries={['/student/7']}>
        <GoToB />
        <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
      </MemoryRouter>
    );
    await screen.findByText('Clear and usable.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Bea' }));
    await waitFor(() => expect(getGradeCards).toHaveBeenCalledWith(8, { courseId: 1 }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(6));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });
});
