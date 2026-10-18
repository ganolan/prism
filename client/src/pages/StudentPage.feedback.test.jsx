// Student page = the shared feedback view per assignment (#135): the same
// layout as the gradebook modal, full descriptors for an attached rubric,
// feedback rows on an unaligned task, and this student's OneDrive "Open" links and
// submission comment chips, loaded after the page renders. One batch request for
// the rubrics (no N+1 on load).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));
vi.mock('../services/api.js', async (orig) => ({
  ...(await orig()),
  getStudent: vi.fn(),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getRubricsForAssignments: vi.fn(),
  getRubricConfig: vi.fn().mockResolvedValue({ reportingCategoryColors: {} }),
  getStudentWorkLinks: vi.fn(),
  getStudentCommentSummaries: vi.fn(),
  getStudentFileSummaries: vi.fn().mockResolvedValue({ assignments: {}, refresh: { queued: 0 } }),
}));

import StudentPage, { CourseSection } from './StudentPage.jsx';
import { getStudent, getRubricsForAssignments, getStudentWorkLinks, getStudentCommentSummaries, getStudentFileSummaries } from '../services/api.js';

const TOPICS = [{ topic_id: 't1', title: 'Select, analyze', external_id: 'ART.5.1', category_title: 'HS Art: Producing', grade: 'EX' }];
const ATTACHMENT = {
  id: 1, mode: 'topics',
  rubric: { criteria: [{ id: 'c1', position: 1, criterion_name: 'UI/UX',
    descriptors: { ED: 'Polished and intuitive.', EX: 'Clear and usable.', D: 'Inconsistent.', EM: 'Hard to use.' } }] },
  topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }],
};
const ROWS_ATTACHMENT = {
  id: 2, mode: 'feedback_rows', topicByCriterion: [], rowLevels: { Playtesting: 'EX' },
  rubric: { criteria: [{ id: 'c9', position: 1, criterion_name: 'Playtesting', standard_title: 'Refine work',
    descriptors: { ED: 'Iterates from evidence.', EX: 'Tests and fixes.', D: 'Tests once.', EM: 'No testing.' } }] },
};
const LINK = { url: 'https://hkis-my.sharepoint.com/f.pptx?d=w1', fileName: 'f.pptx', modifiedAt: '2026-10-01T01:00:00Z' };

const grade = (over = {}) => ({
  course_id: 1, assignment_id: 10, schoology_assignment_id: 'sa-10', assignment_title: 'Portfolio',
  due_date: '2026-04-12', score: 75, assignment_max_points: 100, exception: 0, late: 0, draft: 0,
  submitted_at: 1, submission_type: 'drop', grading_scale_id: null, mastery: { topics: TOPICS },
  grade_comment: 'Strong reflection.', ...over,
});

function renderSection(grades, rubrics, props = {}) {
  return render(
    <MemoryRouter>
      <CourseSection course={{ id: 1, course_name: 'Art' }} grades={grades} flagsByAssignment={{}}
        studentUid="u1" scales={{}} studentName="Ada Lovelace" rubrics={rubrics} studentId={7} {...props} />
    </MemoryRouter>
  );
}
const NONE = { attachments: {}, palette: {} };

beforeEach(() => vi.clearAllMocks());

describe('CourseSection: shared feedback view (#135)', () => {
  it('shows an attached rubric\'s descriptors with the awarded level, comment below', () => {
    renderSection([grade()], { attachments: { 'sa-10': ATTACHMENT }, palette: {} });
    const awarded = screen.getByText('Clear and usable.').closest('td');
    expect(awarded).toHaveAttribute('data-awarded', 'true');
    const comment = screen.getByText('Strong reflection.');
    expect(awarded.compareDocumentPosition(comment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('without an attached rubric keeps the compact grid', () => {
    renderSection([grade()], NONE);
    expect(screen.getByText('Measurement Topic')).toBeInTheDocument();
    expect(screen.queryByText('Clear and usable.')).not.toBeInTheDocument();
  });

  it('badges come before the rubric, as in the gradebook modal', () => {
    renderSection([grade({ score: null })], NONE);
    const badge = screen.getByText('Submitted');
    expect(badge.closest('.assignment-feedback__badges')).not.toBeNull();
    expect(badge.compareDocumentPosition(screen.getByText('Select, analyze')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a points-only task shows its score in the rubric\'s place', () => {
    renderSection([grade({ mastery: null, score: 50 })], NONE);
    expect(screen.getByText('50 / 100')).toBeInTheDocument();
    expect(screen.getByText('Strong reflection.')).toBeInTheDocument();
  });

  it('an unaligned task with a rubric shows its feedback rows and the overall level', () => {
    renderSection([grade({ mastery: null, score: 75 })], { attachments: { 'sa-10': ROWS_ATTACHMENT }, palette: {} });
    expect(screen.getByText('Tests and fixes.').closest('td')).toHaveAttribute('data-awarded', 'true');
    expect(within(screen.getByText('Overall:').parentElement).getByText('75 / 100')).toBeInTheDocument();
  });
});

describe('CourseSection: this student\'s links', () => {
  it('shows the OneDrive Open link and the comments chip in the badges row', () => {
    renderSection([grade({ score: null })], NONE, {
      workLinks: { 'sa-10': LINK },
      commentSummaries: { 'sa-10': { count: 2, student_text: true, read_at: '2026-10-17T02:00:00.000Z' } },
    });
    const open = screen.getByRole('link', { name: "Open Ada Lovelace's work in OneDrive" });
    expect(open).toHaveAttribute('href', LINK.url);
    const chip = screen.getByRole('button', { name: /2 submission comments, the student wrote text/ });
    const row = screen.getByText('Submitted').closest('.assignment-feedback__badges');
    expect(row).toContainElement(open);
    expect(row).toContainElement(chip);
  });

  it('shows the files chip for a native upload, after the Open link and before the comments chip (#162)', () => {
    renderSection([grade({ score: null })], NONE, {
      fileSummaries: { 'sa-10': { revisions: 2, files: 3, read_at: '2026-10-17T02:00:00.000Z' } },
      commentSummaries: { 'sa-10': { count: 2, read_at: '2026-10-17T02:00:00.000Z' } },
    });
    const files = screen.getByRole('button', { name: 'Submitted files: 3 files in 2 revisions. Open the list' });
    expect(files).toHaveTextContent('3 files');
    const row = screen.getByText('Submitted').closest('.assignment-feedback__badges');
    expect(row).toContainElement(files);
    const comments = screen.getByRole('button', { name: /2 submission comments/ });
    expect(files.compareDocumentPosition(comments) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a never-read upload shows a plain Files chip; none on OneDrive work, a test, no upload, or with the feature off', () => {
    const { unmount } = renderSection([grade()], NONE, { fileSummaries: {} });
    expect(screen.getByRole('button', { name: 'Submitted files: not read yet. Open the list' })).toHaveTextContent('Files');
    unmount();
    const none = [
      grade({ is_lti_submission: 1, assignment_id: 11, schoology_assignment_id: 'sa-11' }),
      grade({ is_test: 1, submission_type: 'assessment', assignment_id: 12, schoology_assignment_id: 'sa-12' }),
      grade({ submission_type: null, assignment_id: 13, schoology_assignment_id: 'sa-13' }),
    ];
    const again = renderSection(none, NONE, { fileSummaries: {} });
    expect(screen.queryByRole('button', { name: /Submitted files/ })).not.toBeInTheDocument();
    again.unmount();
    renderSection([grade()], NONE, { fileSummaries: null });
    expect(screen.queryByRole('button', { name: /Submitted files/ })).not.toBeInTheDocument();
  });

  it('no chip while the feature is off, nor on a task the student never touched', () => {
    const { unmount } = renderSection([grade()], NONE, { commentSummaries: null });
    expect(screen.queryByRole('button', { name: /submission comment/ })).not.toBeInTheDocument();
    unmount();
    renderSection([grade({ score: null, submitted_at: 0, submission_type: null })], NONE, { commentSummaries: {} });
    expect(screen.queryByRole('button', { name: /submission comment/ })).not.toBeInTheDocument();
  });
});

describe('StudentPage: loading', () => {
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
  const renderPage = () => render(
    <MemoryRouter initialEntries={['/student/7']}>
      <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
    </MemoryRouter>
  );

  it('asks for every assignment\'s rubric in a single batch, with this student\'s uid', async () => {
    getStudent.mockResolvedValue(student);
    getRubricsForAssignments.mockResolvedValue({ attachments: { 'sa-20': ATTACHMENT } });
    getStudentWorkLinks.mockResolvedValue({ links: {}, status: {} });
    getStudentCommentSummaries.mockResolvedValue({ assignments: {}, refresh: { queued: 0 } });
    renderPage();
    expect(await screen.findByText('Clear and usable.')).toBeInTheDocument();
    expect(getRubricsForAssignments).toHaveBeenCalledTimes(1);
    expect(getRubricsForAssignments).toHaveBeenCalledWith(['sa-10', 'sa-20', 'sa-21', 'sa-22', 'sa-23', 'sa-24'], { studentUid: 'u1' });
  });

  it('renders first, then fills in OneDrive links a few assignments at a time, and reads this student\'s comments', async () => {
    getStudent.mockResolvedValue(student);
    getRubricsForAssignments.mockResolvedValue({ attachments: {} });
    let releaseFirst;
    getStudentWorkLinks
      .mockImplementationOnce(() => new Promise((r) => { releaseFirst = () => r({ links: { 'sa-20': LINK, 'sa-22': null }, status: {} }); }))
      .mockResolvedValueOnce({ links: { 'sa-24': { ...LINK, url: 'https://hkis-my.sharepoint.com/g.pptx?d=w2' } }, status: {} });
    getStudentCommentSummaries.mockResolvedValue({ assignments: { 'sa-10': { count: 1, read_at: '2026-10-17T02:00:00.000Z' } }, refresh: { queued: 0 } });
    renderPage();
    // The page is up while the first lookup is still running.
    expect(await screen.findByText('Poster')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /work in OneDrive/ })).not.toBeInTheDocument();
    expect(getStudentWorkLinks).toHaveBeenCalledTimes(1);
    expect(getStudentWorkLinks).toHaveBeenCalledWith(7, ['sa-20', 'sa-22', 'sa-23']);
    releaseFirst();
    expect(await screen.findAllByRole('link', { name: "Open Ada Lovelace's work in OneDrive" })).toHaveLength(2);
    expect(getStudentWorkLinks).toHaveBeenLastCalledWith(7, ['sa-24']);
    expect(getStudentCommentSummaries).toHaveBeenCalledWith(7, { refresh: true });
    expect(await screen.findByRole('button', { name: /1 submission comment\b/ })).toBeInTheDocument();
  });

  it('reads this student\'s file chips after the page renders, then once more when a background read was queued', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getStudent.mockResolvedValue(student);
      getRubricsForAssignments.mockResolvedValue({ attachments: {} });
      getStudentWorkLinks.mockResolvedValue({ links: {}, status: {} });
      getStudentCommentSummaries.mockResolvedValue({ assignments: {}, refresh: { queued: 0 } });
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
});
