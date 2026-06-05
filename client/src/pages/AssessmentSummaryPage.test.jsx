import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useState } from 'react';
import AssessmentSummaryPage, { StudentRubricCard } from './AssessmentSummaryPage.jsx';
import { createFlag, deleteFlag, writeMasteryScores, writeMasteryComment, sendAllGrades, getMasteryForAssignment, getFeedbackForAssignment, getAssessmentAnalysis } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  getFeedbackForAssignment: vi.fn().mockResolvedValue({}),
  getAssessmentAnalysis: vi.fn().mockResolvedValue(null),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn().mockResolvedValue({}),
  writeMasteryComment: vi.fn().mockResolvedValue({}),
  sendAllGrades: vi.fn().mockResolvedValue({ results: [] }),
  createFlag: vi.fn().mockResolvedValue({ id: 99, flag_reason: 'Check citations' }),
  deleteFlag: vi.fn().mockResolvedValue({ success: true }),
}));

const TOPICS = [
  { id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' },
];

function makeStudent() {
  return {
    id: 1,
    enrollment_id: 'enr-1',
    schoology_uid: 'uid-1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    preferred_name: null,
    preferred_name_teacher: null,
    grade_comment: '',
    comment_status: 0,
    exception: null,
    scores: {},
  };
}

function renderCard(extraProps = {}) {
  const { student, ...rest } = extraProps;
  return render(
    <MemoryRouter>
      <StudentRubricCard
        student={student || makeStudent()}
        topics={TOPICS}
        courseId="4"
        assignmentId="8"
        assignmentRow={{ id: 50, mastery_grading_period_id: 1, mastery_grading_category_id: 2 }}
        onSaved={() => {}}
        {...rest}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('StudentRubricCard draft persistence', () => {
  it('restores pending rubric selection and comment text after a remount', () => {
    const { unmount } = renderCard();

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    fireEvent.change(screen.getByPlaceholderText(/Teacher comment/i), {
      target: { value: 'work in progress' },
    });

    // Two distinct changes now count: the rubric draft + the comment edit.
    expect(screen.getByText('2 pending changes')).toBeInTheDocument();

    unmount();
    renderCard();

    expect(screen.getByText('2 pending changes')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Teacher comment/i)).toHaveValue(
      'work in progress'
    );
  });

  it('clears the stored draft after a successful save', async () => {
    // The card stays mounted after a save now (#50), but unmount it here anyway
    // to prove the draft is cleared regardless of whether the card lives on.
    function SaveHarness() {
      const [mounted, setMounted] = useState(true);
      if (!mounted) return null;
      return (
        <StudentRubricCard
          student={makeStudent()}
          topics={TOPICS}
          courseId="4"
          assignmentId="8"
          assignmentRow={{ mastery_grading_period_id: 1, mastery_grading_category_id: 2 }}
          onSaved={() => setMounted(false)}
        />
      );
    }
    render(
      <MemoryRouter>
        <SaveHarness />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Publish to Schoology' }));

    await waitFor(() => {
      expect(
        localStorage.getItem('prism:assessment-draft:4:8:enr-1')
      ).toBeNull();
    });
  });

  it('does not write a draft when there are no unsaved changes', () => {
    renderCard();
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).toBeNull();
  });

  it('restores the display-to-student toggle after a remount', () => {
    const { unmount } = renderCard();

    const toggle = screen.getByRole('switch', { name: /display to student/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    unmount();
    renderCard();

    expect(
      screen.getByRole('switch', { name: /display to student/i })
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('persists and restores a comment draft for a rubric-locked card', () => {
    const lockedStudent = { ...makeStudent(), exception: 3 };

    const { unmount } = renderCard({ student: lockedStudent });

    fireEvent.change(screen.getByPlaceholderText(/Teacher comment/i), {
      target: { value: 'locked but commented' },
    });
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).not.toBeNull();

    unmount();
    renderCard({ student: lockedStudent });

    expect(screen.getByPlaceholderText(/Teacher comment/i)).toHaveValue(
      'locked but commented'
    );
  });

  it('discards a stale draft when Schoology data changed (Schoology wins)', () => {
    const { unmount } = renderCard();

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    fireEvent.change(screen.getByPlaceholderText(/Teacher comment/i), {
      target: { value: 'my draft comment' },
    });
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).not.toBeNull();

    unmount();

    // Simulate Schoology holding newer data when the page next syncs.
    const updatedStudent = { ...makeStudent(), grade_comment: 'published in schoology' };
    renderCard({ student: updatedStudent });

    // Schoology wins: the synced comment shows, the stale draft is gone.
    expect(screen.getByPlaceholderText(/Teacher comment/i)).toHaveValue(
      'published in schoology'
    );
    expect(screen.queryByText('1 pending change')).not.toBeInTheDocument();
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).toBeNull();
  });

  it('discards a legacy draft that has no base signature', () => {
    // Drafts persisted before the staleness feature have no `base` key; they
    // must be treated as stale and discarded.
    localStorage.setItem(
      'prism:assessment-draft:4:8:enr-1',
      JSON.stringify({ pending: { t1: 'D' }, comment: 'legacy draft', display: true })
    );
    renderCard();
    expect(screen.queryByText('1 pending change')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Teacher comment/i)).toHaveValue('');
    expect(localStorage.getItem('prism:assessment-draft:4:8:enr-1')).toBeNull();
  });

  it('clears the stored draft when changes are discarded', () => {
    renderCard();

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /discard changes/i }));

    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).toBeNull();
  });
});

describe('StudentRubricCard — cell language (Slice 1)', () => {
  it('renders each level header with its header-tint fill and black text', () => {
    renderCard();
    const edHeader = screen.getByText('Exhibiting Depth').closest('th');
    expect(edHeader).toHaveStyle({ background: '#bfdbfe', color: '#1a1a1a' });
    const ieHeader = screen.getByText('Insufficient Evidence').closest('th');
    expect(ieHeader).toHaveStyle({ background: '#fecaca', color: '#1a1a1a' });
  });

  it('renders a synced final cell with its final fill, 2px final border, bold, black text', () => {
    const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
    renderCard({ student: s });
    const cell = screen.getByTitle('Set Topic 1 to Exhibiting Depth');
    expect(cell).toHaveStyle({
      background: '#bfdbfe', border: '2px solid #2563eb', color: '#1a1a1a', fontWeight: '700',
    });
    expect(cell).toHaveTextContent('ED');
  });

  it('renders a pending draft cell with its draft fill, 2px draft border, black text', () => {
    renderCard(); // empty scores
    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    const cell = screen.getByTitle('Set Topic 1 to Developing');
    expect(cell).toHaveStyle({
      background: '#fefce8', border: '2px dashed #fcd34d', color: '#1a1a1a',
    });
  });

  it('renders an empty cell with the default card background and no level code', () => {
    renderCard();
    const cell = screen.getByTitle('Set Topic 1 to Emerging');
    expect(cell).toHaveStyle({ background: 'var(--card-bg)' });
    expect(cell).toHaveTextContent('');
  });

  it('renders the overridden synced final as empty when a draft is pending on another cell', () => {
    const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
    renderCard({ student: s });
    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing')); // draft on D
    const oldFinal = screen.getByTitle('Set Topic 1 to Exhibiting Depth'); // ED
    expect(oldFinal).toHaveStyle({ background: 'var(--card-bg)' });
  });
});

describe('StudentRubricCard review flag (#20)', () => {
  it('shows a "Flag for review" button when there is no review flag', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /flag for review/i })).toBeInTheDocument();
  });

  it('creates a submission-scoped review_needed flag with a reason', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.change(screen.getByPlaceholderText('Reason for review...'), {
      target: { value: 'Check citations' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));

    await waitFor(() => {
      expect(createFlag).toHaveBeenCalledWith({
        student_id: 1,
        assignment_id: 50,
        flag_type: 'review_needed',
        flag_reason: 'Check citations',
      });
    });
    expect(await screen.findByText(/Review: Check citations/)).toBeInTheDocument();
  });

  it('creates the flag when Enter is pressed in the reason input', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    const input = screen.getByPlaceholderText('Reason for review...');
    fireEvent.change(input, { target: { value: 'Check citations' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(createFlag).toHaveBeenCalledWith({
        student_id: 1,
        assignment_id: 50,
        flag_type: 'review_needed',
        flag_reason: 'Check citations',
      });
    });
    expect(await screen.findByText(/Review: Check citations/)).toBeInTheDocument();
  });

  it('does not create a flag when Enter is pressed with an empty reason', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.keyDown(screen.getByPlaceholderText('Reason for review...'), { key: 'Enter' });
    expect(createFlag).not.toHaveBeenCalled();
  });

  it('cancels the reason input when Escape is pressed', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    const input = screen.getByPlaceholderText('Reason for review...');
    fireEvent.change(input, { target: { value: 'oops' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Reason for review...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /flag for review/i })).toBeInTheDocument();
  });

  it('cancels the reason input via the Cancel button', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Reason for review...')).not.toBeInTheDocument();
    expect(createFlag).not.toHaveBeenCalled();
  });

  it('shows the review badge and a Clear control when a flag exists', () => {
    renderCard({ student: { ...makeStudent(), review_flag: { id: 7, flag_reason: 'Re-mark' } } });
    expect(screen.getByText(/Review: Re-mark/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear review flag' })).toBeInTheDocument();
  });

  it('clears the review flag via deleteFlag', async () => {
    renderCard({ student: { ...makeStudent(), review_flag: { id: 7, flag_reason: 'Re-mark' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear review flag' }));
    await waitFor(() => expect(deleteFlag).toHaveBeenCalledWith(7));
  });

  it('flagging for review does not trigger a Schoology write', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.change(screen.getByPlaceholderText('Reason for review...'), {
      target: { value: 'Check citations' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    await waitFor(() => expect(createFlag).toHaveBeenCalled());
    expect(writeMasteryScores).not.toHaveBeenCalled();
    expect(writeMasteryComment).not.toHaveBeenCalled();
  });

  it('shows an error and keeps no flag when creation fails', async () => {
    createFlag.mockRejectedValueOnce(new Error('network down'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.change(screen.getByPlaceholderText('Reason for review...'), {
      target: { value: 'Check citations' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));

    expect(await screen.findByText(/Flag failed: network down/)).toBeInTheDocument();
    expect(screen.queryByText(/Review: Check citations/)).not.toBeInTheDocument();
  });
});

describe('StudentRubricCard — re-submit requested toggle', () => {
  it('shows the ghost toggle when no resubmit flag is set', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /ask to resubmit/i })).toBeInTheDocument();
  });

  it('creates a resubmit_requested flag with no reason on click', async () => {
    createFlag.mockResolvedValueOnce({ id: 71, flag_type: 'resubmit_requested', flag_reason: null });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /ask to resubmit/i }));
    await waitFor(() => {
      expect(createFlag).toHaveBeenCalledWith({
        student_id: 1,
        assignment_id: 50,
        flag_type: 'resubmit_requested',
      });
    });
    expect(await screen.findByText(/resubmission requested/i)).toBeInTheDocument();
  });

  it('clears the flag via the ✕ control', async () => {
    renderCard({ student: { ...makeStudent(), resubmit_flag: { id: 71 } } });
    fireEvent.click(screen.getByRole('button', { name: /clear re-submit request/i }));
    await waitFor(() => expect(deleteFlag).toHaveBeenCalledWith(71));
  });

  it('the flag write does not trigger a Schoology write', async () => {
    createFlag.mockResolvedValueOnce({ id: 71 });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /ask to resubmit/i }));
    await waitFor(() => expect(createFlag).toHaveBeenCalled());
    expect(writeMasteryScores).not.toHaveBeenCalled();
    expect(writeMasteryComment).not.toHaveBeenCalled();
  });

  it('shows a read-only Resubmitted pill when student.resubmitted is true', () => {
    renderCard({ student: { ...makeStudent(), resubmitted: true } });
    const pill = screen.getByText(/Ungraded resubmission/);
    expect(pill).toBeInTheDocument();
    expect(pill.tagName).not.toBe('BUTTON');
  });

  it('does not show the Resubmitted pill when student.resubmitted is false', () => {
    renderCard({ student: { ...makeStudent(), resubmitted: false } });
    expect(screen.queryByText(/Ungraded resubmission/)).not.toBeInTheDocument();
  });
});

describe('StudentRubricCard — student photo (#24)', () => {
  it('renders the student photo when picture_url is present', () => {
    renderCard({ student: { ...makeStudent(), picture_url: 'https://schoology/p.jpg' } });
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('https://schoology/p.jpg');
  });

  it('falls back to initials when there is no picture_url', () => {
    renderCard(); // Ada Lovelace, no photo
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('AL')).toBeInTheDocument();
  });
});

describe('StudentRubricCard — in-place save (#50)', () => {
  it('reports saved values up via onSaved(uid, patch) instead of forcing a reload', async () => {
    const onSaved = vi.fn();
    renderCard({ onSaved });

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    fireEvent.change(screen.getByPlaceholderText(/Teacher comment/i), {
      target: { value: 'nice work' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Schoology' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [uid, patch] = onSaved.mock.calls[0];
    expect(uid).toBe('uid-1');
    expect(patch.scores.t1).toEqual({ points: 50, grade: 'D' });
    expect(patch.grade_comment).toBe('nice work');
    // Card stays mounted — the success badge is still on screen.
    expect(await screen.findByText('Saved ✓')).toBeInTheDocument();
  });
});

describe('StudentRubricCard — rubric interaction (Slice 2)', () => {
  it('clears a pending draft when its cell is clicked again', () => {
    renderCard();
    const cell = screen.getByTitle('Set Topic 1 to Developing');
    fireEvent.click(cell);
    expect(screen.getByText('1 pending change')).toBeInTheDocument();
    fireEvent.click(cell);
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
  });

  it('stages a synced final for removal on click, showing the red removal marker', () => {
    const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
    renderCard({ student: s });
    const finalCell = screen.getByTitle('Set Topic 1 to Exhibiting Depth'); // ED
    fireEvent.click(finalCell);
    expect(screen.getByText('1 pending change')).toBeInTheDocument();
    expect(finalCell).toHaveStyle({ outline: '1.5px dashed #ef4444' });
    expect(finalCell).toHaveTextContent('✕');
  });

  it('unstages a removal when the staged final cell is clicked again', () => {
    const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
    renderCard({ student: s });
    const finalCell = screen.getByTitle('Set Topic 1 to Exhibiting Depth');
    fireEvent.click(finalCell); // stage removal
    fireEvent.click(finalCell); // unstage
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
    expect(finalCell).toHaveStyle({ background: '#bfdbfe' }); // back to final fill
  });

  it('omits a removal-staged topic from the Schoology grade payload', async () => {
    const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
    const onSaved = vi.fn();
    renderCard({ student: s, onSaved });
    fireEvent.click(screen.getByTitle('Set Topic 1 to Exhibiting Depth')); // stage removal of ED
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Schoology' }));

    await waitFor(() => expect(writeMasteryScores).toHaveBeenCalled());
    const payload = writeMasteryScores.mock.calls[0][1];
    expect(payload.gradeInfo.t1).toBeUndefined(); // topic cleared → not in the replace set
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onSaved.mock.calls[0][1].scores.t1).toBeUndefined();
  });

  it('replaces a staged removal with a draft when a different cell is clicked', () => {
    const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
    renderCard({ student: s });
    fireEvent.click(screen.getByTitle('Set Topic 1 to Exhibiting Depth')); // stage REMOVE on ED
    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));        // new draft on D
    expect(screen.getByText('1 pending change')).toBeInTheDocument();
    const draftCell = screen.getByTitle('Set Topic 1 to Developing');
    expect(draftCell).toHaveStyle({ background: '#fefce8' }); // D draftFill
  });

  it('reverts to the synced final in one click after stage-removal then a draft elsewhere', () => {
    // Regression: final ED → click ED (stage removal) → click EX (draft) →
    // click ED (the original final) must revert straight back to the synced
    // final, NOT show ED as a draft.
    const s = { ...makeStudent(), scores: { t1: { grade: 'ED', points: 100 } } };
    renderCard({ student: s });
    const edCell = screen.getByTitle('Set Topic 1 to Exhibiting Depth'); // ED (synced final)
    fireEvent.click(edCell);                                              // stage removal
    fireEvent.click(screen.getByTitle('Set Topic 1 to Exhibiting'));      // draft EX
    expect(screen.getByText('1 pending change')).toBeInTheDocument();
    fireEvent.click(edCell);                                              // back to original final
    // One click reverts: no pending change, ED renders as the solid final again.
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
    expect(edCell).toHaveStyle({ background: '#bfdbfe', border: '2px solid #2563eb' });
  });
});

describe('AssessmentSummaryPage — Send all bar (#51)', () => {
  function makeData() {
    return {
      assignment: { id: 50, schoology_assignment_id: '8', title: 'Quiz', mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
      topics: TOPICS,
      students: [
        { ...makeStudent(), id: 1, schoology_uid: 'uid-1', last_name: 'Lovelace', enrollment_id: 'enr-1' },
        { ...makeStudent(), id: 2, schoology_uid: 'uid-2', first_name: 'Alan', last_name: 'Turing', enrollment_id: 'enr-2' },
      ],
    };
  }

  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/course/4/assessment/8']}>
        <Routes>
          <Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('disables Send all when no card has unsaved changes', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    renderPage();
    const btn = await screen.findByRole('button', { name: /publish all to schoology/i });
    expect(btn).toBeDisabled();
  });

  it('counts pending cards and sends them in one batched request', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    sendAllGrades.mockResolvedValue({ results: [{ uid: 'uid-1', ok: true }] });
    renderPage();
    await screen.findByRole('button', { name: /publish all to schoology/i });

    // Make a pending change on the first card only.
    fireEvent.click(screen.getAllByTitle('Set Topic 1 to Developing')[0]);

    const btn = await screen.findByRole('button', { name: /publish all to schoology \(1\)/i });
    expect(btn).toBeEnabled();

    fireEvent.click(btn);

    // One batched call, not a per-card loop.
    await waitFor(() => expect(sendAllGrades).toHaveBeenCalledTimes(1));
    expect(writeMasteryScores).not.toHaveBeenCalled();
    const [courseId, entries] = sendAllGrades.mock.calls[0];
    expect(courseId).toBe('4');
    expect(entries).toHaveLength(1);
    expect(entries[0].uid).toBe('uid-1');
    expect(entries[0].scores.gradeInfo.t1.grade).toBe('50');
    expect(await screen.findByText(/Published 1 grade/)).toBeInTheDocument();
  });

  it('batches multiple pending cards into a single request and marks each saved', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    sendAllGrades.mockResolvedValue({ results: [{ uid: 'uid-1', ok: true }, { uid: 'uid-2', ok: true }] });
    renderPage();
    await screen.findByRole('button', { name: /publish all to schoology/i });

    fireEvent.click(screen.getAllByTitle('Set Topic 1 to Developing')[0]);
    fireEvent.click(screen.getAllByTitle('Set Topic 1 to Developing')[1]);

    const btn = await screen.findByRole('button', { name: /publish all to schoology \(2\)/i });
    fireEvent.click(btn);

    await waitFor(() => expect(sendAllGrades).toHaveBeenCalledTimes(1));
    const [, entries] = sendAllGrades.mock.calls[0];
    expect(entries).toHaveLength(2);
    expect(await screen.findByText(/Published 2 grades/)).toBeInTheDocument();
    // Both cards show their per-card saved badge after the batch.
    await waitFor(() => expect(screen.getAllByText('Saved ✓')).toHaveLength(2));
  });

  it('Discard all reverts every pending card without any Schoology write', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    renderPage();
    await screen.findByRole('button', { name: /publish all to schoology/i });

    fireEvent.click(screen.getAllByTitle('Set Topic 1 to Developing')[0]);
    fireEvent.click(screen.getAllByTitle('Set Topic 1 to Developing')[1]);
    await screen.findByRole('button', { name: /publish all to schoology \(2\)/i });

    // First click arms the confirm; nothing is discarded yet (both cards still
    // show their own per-card pending badge).
    fireEvent.click(screen.getByRole('button', { name: /^discard all$/i }));
    expect(screen.getByRole('button', { name: /click again to confirm/i })).toBeInTheDocument();
    expect(screen.getAllByText(/pending change/)).toHaveLength(2);
    // Second click confirms and discards.
    fireEvent.click(screen.getByRole('button', { name: /click again to confirm/i }));

    // Both cards return to no-changes; the bulk button drops its count and disables.
    await waitFor(() =>
      expect(screen.queryByText(/pending change/)).not.toBeInTheDocument()
    );
    const publishBtn = screen.getByRole('button', { name: /^publish all to schoology$/i });
    expect(publishBtn).toBeDisabled();
    expect(sendAllGrades).not.toHaveBeenCalled();
    expect(writeMasteryScores).not.toHaveBeenCalled();
  });

  it('renders a bulk show-all toggle on the whole-class bar', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    renderPage();
    const bulk = await screen.findByRole('switch', { name: /display all to students/i });
    expect(bulk).toBeInTheDocument();
    expect(bulk).toHaveTextContent('Hide all'); // both students start hidden
  });

  it('bulk show-all sets every card visible and marks them pending', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData()); // both students start hidden
    renderPage();
    const bulkToggle = await screen.findByRole('switch', { name: /display all to students/i });
    expect(bulkToggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByRole('switch', { name: /^display to student$/i })).toHaveLength(2);

    fireEvent.click(bulkToggle);

    await waitFor(() =>
      screen.getAllByRole('switch', { name: /^display to student$/i })
        .forEach(sw => expect(sw).toHaveAttribute('aria-checked', 'true'))
    );
    expect(screen.getByRole('switch', { name: /display all to students/i }))
      .toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByText(/pending change/)).toHaveLength(2);
  });
});

describe('StudentRubricCard — card chrome (Slice 5)', () => {
  const withFeedback = (parsed) => ({ feedbackRow: { feedback_parsed: parsed } });

  it('renders the reviewer-flags strip, collapsed by default, when reviewer_flags is present', () => {
    renderCard(withFeedback({ reviewer_flags: 'No prototype link pasted.' }));
    const summary = screen.getByText(/Reviewer flags/);
    expect(summary).toBeInTheDocument();
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open'); // collapsed by default
    expect(details).toHaveTextContent('No prototype link pasted.');
  });

  it('does not render the flags strip when reviewer_flags is absent', () => {
    renderCard(withFeedback({ narrative_feedback: 'x' }));
    expect(screen.queryByText(/Reviewer flags/)).not.toBeInTheDocument();
  });

  it('makes the comment the hero with a bold label and a larger textarea', () => {
    renderCard();
    const ta = screen.getByPlaceholderText(/Teacher comment/i);
    expect(ta).toHaveStyle({ fontSize: '0.84rem' });
  });

  it('shows the display toggle as an eye-icon switch with no text label', () => {
    renderCard();
    const toggle = screen.getByRole('switch', { name: /display to student/i });
    expect(toggle).toBeInTheDocument();
    expect(screen.queryByText('Display to student')).not.toBeInTheDocument();
  });

  it('counts a visibility toggle as a pending change', () => {
    renderCard();
    fireEvent.click(screen.getByRole('switch', { name: /display to student/i }));
    expect(screen.getByText('1 pending change')).toBeInTheDocument();
  });

  it('always shows the discard control, disabled when there are no pending changes', () => {
    renderCard();
    const discard = screen.getByRole('button', { name: /discard changes/i });
    expect(discard).toBeDisabled();
  });

  it('enables discard once there is a pending change and clears it on click', () => {
    renderCard();
    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    const discard = screen.getByRole('button', { name: /discard changes/i });
    expect(discard).toBeEnabled();
    fireEvent.click(discard);
    expect(screen.queryByText(/pending change/)).not.toBeInTheDocument();
  });

  const withFeedback2 = (parsed) => ({ feedbackRow: { feedback_parsed: parsed } });

  it('shows the suggested-feedback box and Use suggestion only when a suggestion exists', () => {
    renderCard(); // no feedbackRow
    expect(screen.queryByText('✦ Suggested feedback')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use suggestion/i })).not.toBeInTheDocument();
  });

  it('renders the suggestion box (read-only) and Use suggestion when narrative_feedback exists', () => {
    renderCard(withFeedback2({ narrative_feedback: 'Excellent work, Ada!' }));
    expect(screen.getByText('✦ Suggested feedback')).toBeInTheDocument();
    expect(screen.getByText('Excellent work, Ada!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use suggestion/i })).toBeInTheDocument();
  });

  it('Use suggestion overwrites the comment with normalized text and arms pending changes', () => {
    renderCard(withFeedback2({ narrative_feedback: 'Line one.\v\v​Line two.' }));
    fireEvent.click(screen.getByRole('button', { name: /use suggestion/i }));
    const ta = screen.getByPlaceholderText(/Teacher comment/i);
    expect(ta).toHaveValue('Line one.\n\nLine two.'); // normalizePastedText applied
    expect(screen.getByRole('button', { name: 'Publish to Schoology' })).toBeEnabled();
  });

  it('hides Use suggestion and the box when only rubric_scores exist (no narrative)', () => {
    renderCard({ feedbackRow: { feedback_parsed: { rubric_scores: { X1: 'ED' } } } });
    expect(screen.queryByRole('button', { name: /use suggestion/i })).not.toBeInTheDocument();
    expect(screen.queryByText('✦ Suggested feedback')).not.toBeInTheDocument();
  });
});

describe('StudentRubricCard — comment publish indicator', () => {
  it('shows "Published" with a green border when the comment matches the synced value', () => {
    renderCard({ student: { ...makeStudent(), grade_comment: 'Nice work' } });
    expect(screen.getByText(/Published to Schoology/)).toBeInTheDocument();
    expect(screen.queryByText(/Unsaved/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Teacher comment/i).getAttribute('style'))
      .toContain('var(--success)');
  });

  it('flips to "Unsaved" with an amber border once the comment is edited', () => {
    renderCard({ student: { ...makeStudent(), grade_comment: 'Nice work' } });
    fireEvent.change(screen.getByPlaceholderText(/Teacher comment/i), {
      target: { value: 'Nice work!!' },
    });
    expect(screen.getByText(/Draft - not published/)).toBeInTheDocument();
    expect(screen.queryByText(/Published to Schoology/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Teacher comment/i).getAttribute('style'))
      .toContain('var(--warning)');
  });

  it('shows no publish indicator for an empty comment', () => {
    renderCard();
    expect(screen.queryByText(/Published to Schoology/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unsaved/)).not.toBeInTheDocument();
  });
});

describe('AssessmentSummaryPage — header + Reviewer Analysis (Slice 6)', () => {
  function makeData() {
    return {
      assignment: { id: 50, schoology_assignment_id: '8', title: 'Quiz', mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
      topics: [{ id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' }],
      students: [{ ...makeStudent(), id: 1, schoology_uid: 'uid-1', enrollment_id: 'enr-1', scores: {} }],
    };
  }
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/course/4/assessment/8']}>
        <Routes>
          <Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('removes the stale proficiency legend', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    renderPage();
    await screen.findByText('Quiz');
    expect(screen.queryByText(/green border = pending/)).not.toBeInTheDocument();
  });

  it('does not render the Reviewer Analysis button when no analysis exists', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    getFeedbackForAssignment.mockResolvedValue({});
    getAssessmentAnalysis.mockResolvedValue(null);
    renderPage();
    await screen.findByText('Quiz');
    expect(screen.queryByRole('button', { name: /reviewer analysis/i })).not.toBeInTheDocument();
  });

  it('renders the button when at least one feedback row exists', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    getFeedbackForAssignment.mockResolvedValue({ 1: { feedback_parsed: { rubric_scores: { X1: 'ED' } } } });
    getAssessmentAnalysis.mockResolvedValue(null);
    renderPage();
    expect(await screen.findByRole('button', { name: /reviewer analysis/i })).toBeInTheDocument();
  });

  it('renders the button when an analysis record exists even without feedback rows', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    getFeedbackForAssignment.mockResolvedValue({});
    getAssessmentAnalysis.mockResolvedValue({ analysis_parsed: { noticings: [] } });
    renderPage();
    expect(await screen.findByRole('button', { name: /reviewer analysis/i })).toBeInTheDocument();
  });

  it('opens the drawer with the not-student-facing tag and closes via ✕', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    getFeedbackForAssignment.mockResolvedValue({ 1: { feedback_parsed: { rubric_scores: { X1: 'ED' } } } });
    getAssessmentAnalysis.mockResolvedValue({ analysis_parsed: { noticings: [] } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /reviewer analysis/i }));
    expect(screen.getByText('not student-facing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close reviewer analysis/i }));
    await waitFor(() => expect(screen.queryByText('not student-facing')).not.toBeInTheDocument());
  });

  it('shows the proposed distribution computed from feedback and the noticings', async () => {
    const data = makeData();
    getMasteryForAssignment.mockResolvedValue(data);
    getFeedbackForAssignment.mockResolvedValue({
      1: { feedback_parsed: { rubric_scores: { X1: 'ED' } } },
      2: { feedback_parsed: { rubric_scores: { X1: 'EX' } } },
    });
    getAssessmentAnalysis.mockResolvedValue({
      analysis_parsed: {
        noticings: [{ title: 'AI tool use', body: 'Half the class used AI.' }],
        moderation_note: 'Worth a spot-check.',
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /reviewer analysis/i }));

    expect(screen.getByText(/From the reviewer's suggested grades/)).toBeInTheDocument();
    expect(screen.getByText(/1 ED/)).toBeInTheDocument();
    expect(screen.getByText(/1 EX/)).toBeInTheDocument();
    expect(screen.getByText('AI tool use')).toBeInTheDocument();
    expect(screen.getByText('Half the class used AI.')).toBeInTheDocument();
    expect(screen.getByText(/Worth a spot-check/)).toBeInTheDocument();
  });

  it('closes the drawer when the overlay scrim is clicked', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    getFeedbackForAssignment.mockResolvedValue({ 1: { feedback_parsed: { rubric_scores: { X1: 'ED' } } } });
    getAssessmentAnalysis.mockResolvedValue({ analysis_parsed: { noticings: [] } });
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /reviewer analysis/i }));
    expect(screen.getByText('not student-facing')).toBeInTheDocument();
    // The scrim is the fixed full-screen overlay (data-testid set in the JSX).
    const scrim = container.querySelector('[data-testid="reviewer-analysis-scrim"]');
    fireEvent.click(scrim);
    await waitFor(() => expect(screen.queryByText('not student-facing')).not.toBeInTheDocument());
  });
});

describe('AssessmentSummaryPage — feedback load (Slice 4)', () => {
  function makeData() {
    return {
      assignment: { id: 50, schoology_assignment_id: '8', title: 'Quiz', mastery_grading_period_id: 1, mastery_grading_category_id: 2 },
      topics: [{ id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' }],
      students: [{ ...makeStudent(), id: 1, schoology_uid: 'uid-1', enrollment_id: 'enr-1', scores: {} }],
    };
  }
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/course/4/assessment/8']}>
        <Routes>
          <Route path="/course/:id/assessment/:assignmentId" element={<AssessmentSummaryPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('fetches feedback + analysis for the assignment alongside mastery', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    renderPage();
    await waitFor(() => expect(getFeedbackForAssignment).toHaveBeenCalledWith('8'));
    expect(getAssessmentAnalysis).toHaveBeenCalledWith('8');
  });

  it('renders a suggestion overlay (✦) for a resolvable rubric_scores entry', async () => {
    getMasteryForAssignment.mockResolvedValue(makeData());
    getFeedbackForAssignment.mockResolvedValue({
      1: { feedback_parsed: { rubric_scores: { X1: 'ED' }, narrative_feedback: 'nice' } },
    });
    renderPage();
    const cell = await screen.findByTitle('Set Topic 1 to Exhibiting Depth'); // ED
    await waitFor(() => expect(cell).toHaveTextContent('✦'));
    expect(cell).toHaveStyle({ background: '#ede9fe' }); // violet wash, no teacher mark
  });

  it('does not throw or overlay for an unresolvable rubric_scores key', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    getMasteryForAssignment.mockResolvedValue(makeData());
    getFeedbackForAssignment.mockResolvedValue({
      1: { feedback_parsed: { rubric_scores: { NOPE: 'ED' } } },
    });
    renderPage();
    await screen.findByTitle('Set Topic 1 to Exhibiting Depth');
    expect(screen.queryByText('✦')).not.toBeInTheDocument();
    debugSpy.mockRestore();
  });

  it('keeps the solid final border + dashed ring + ✦ when teacher mark and suggestion agree', async () => {
    const data = makeData();
    data.students[0].scores = { t1: { grade: 'ED', points: 100 } }; // teacher final on ED
    getMasteryForAssignment.mockResolvedValue(data);
    getFeedbackForAssignment.mockResolvedValue({
      1: { feedback_parsed: { rubric_scores: { X1: 'ED' } } }, // suggestion also ED
    });
    renderPage();
    const cell = await screen.findByTitle('Set Topic 1 to Exhibiting Depth');
    await waitFor(() => expect(cell).toHaveTextContent('✦'));
    expect(cell).toHaveStyle({
      background: '#bfdbfe', border: '2px solid #2563eb',
      outline: '1px dashed #a78bfa',
    });
  });

  it('places teacher mark and suggestion on different cells side by side', async () => {
    const data = makeData();
    data.students[0].scores = { t1: { grade: 'ED', points: 100 } }; // final ED
    getMasteryForAssignment.mockResolvedValue(data);
    getFeedbackForAssignment.mockResolvedValue({
      1: { feedback_parsed: { rubric_scores: { X1: 'EX' } } }, // suggestion EX
    });
    renderPage();
    const finalCell = await screen.findByTitle('Set Topic 1 to Exhibiting Depth'); // ED
    const suggCell = screen.getByTitle('Set Topic 1 to Exhibiting');             // EX
    expect(finalCell).toHaveStyle({ background: '#bfdbfe' });   // final, no ✦
    expect(finalCell).not.toHaveTextContent('✦');
    expect(suggCell).toHaveStyle({ background: '#ede9fe' });    // violet wash + ✦
    expect(suggCell).toHaveTextContent('✦');
  });
});
