import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import QuizSetupModal from './QuizSetupModal.jsx';
import { getQuizCandidates, checkQuizParity, createQuizGroup, linkQuizResult, deleteQuizGroup, setQuizTemplate } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getQuizCandidates: vi.fn(), checkQuizParity: vi.fn(), createQuizGroup: vi.fn(), linkQuizResult: vi.fn(), deleteQuizGroup: vi.fn(), setQuizTemplate: vi.fn(),
}));

const CANDIDATES = {
  tests: [
    { id: 1, schoology_assignment_id: '900', title: 'Ep 1 Theory Test', suggestedWith: ['901'] },
    { id: 2, schoology_assignment_id: '901', title: 'Ep 1 Theory Test *', suggestedWith: ['900'] },
  ],
  summatives: [{ id: 3, schoology_assignment_id: '950', title: 'Ep 1 Theory Test - Result (S)' }],
};

const CURRENT = { schoology_assignment_id: '900', title: 'Ep 1 Theory Test' };
const GROUP = { id: 7, title: 'Ep 1 Theory Test', result: null, members: [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1 Theory Test' }] };
const LINKED = { ...GROUP, result: { schoology_assignment_id: '950', title: 'Ep 1 Theory Test - Result (S)' } };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Keeps group state the way the page does: onChanged hands back the new group.
function Harness({ initial, onChanged }) {
  const [group, setGroup] = useState(initial);
  return (
    <QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={group} onClose={() => {}}
      onChanged={(next) => { onChanged(next); setGroup(next); }} />
  );
}

beforeEach(() => { vi.resetAllMocks(); getQuizCandidates.mockResolvedValue(CANDIDATES); });

describe('QuizSetupModal', () => {
  it('ticks the suggested copy, checks parity, then combines', async () => {
    checkQuizParity.mockResolvedValue({ ok: true, differences: [] });
    createQuizGroup.mockResolvedValue({ group: { id: 7 } });
    const onChanged = vi.fn();
    render(<QuizSetupModal open courseId={5} currentAssignment={{ schoology_assignment_id: '900', title: 'Ep 1 Theory Test' }} group={null} onClose={() => {}} onChanged={onChanged} />);
    expect(await screen.findByRole('checkbox', { name: 'Ep 1 Theory Test *' })).toBeChecked();
    const combine = screen.getByRole('button', { name: 'Combine' });
    expect(combine).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check questions' }));
    expect(await screen.findByText('Same questions')).toBeInTheDocument();
    fireEvent.click(combine);
    await waitFor(() => expect(createQuizGroup).toHaveBeenCalledWith({ courseId: 5, assignmentIds: ['900', '901'], title: 'Ep 1 Theory Test' }));
    expect(onChanged).toHaveBeenCalledWith({ id: 7 });
  });

  it('a mismatch lists the differing questions and keeps Combine disabled', async () => {
    checkQuizParity.mockResolvedValue({ ok: false, differences: [{ assignmentId: 2, title: 'Ep 1 Theory Test *', missing: ['Which is true?'], extra: ['Which is false?'] }] });
    render(<QuizSetupModal open courseId={5} currentAssignment={{ schoology_assignment_id: '900', title: 'Ep 1 Theory Test' }} group={null} onClose={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check questions' }));
    expect(await screen.findByText(/Which is false\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Combine' })).toBeDisabled();
  });

  it('links a result task for an existing group', async () => {
    linkQuizResult.mockResolvedValue({ group: { id: 7, result: { schoology_assignment_id: '950' } } });
    const group = { id: 7, title: 'Ep 1 Theory Test', result: null, members: [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1 Theory Test' }] };
    render(<QuizSetupModal open courseId={5} currentAssignment={{ schoology_assignment_id: '900', title: 'Ep 1 Theory Test' }} group={group} onClose={() => {}} onChanged={() => {}} />);
    await screen.findByRole('option', { name: 'Ep 1 Theory Test - Result (S)' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Result task' }), { target: { value: '950' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(linkQuizResult).toHaveBeenCalledWith(7, '950'));
  });

  it('a changed ticked set drops the passing check until it is checked again', async () => {
    checkQuizParity.mockResolvedValue({ ok: true, differences: [] });
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={null} onClose={() => {}} onChanged={() => {}} />);
    const second = await screen.findByRole('checkbox', { name: 'Ep 1 Theory Test *' });
    fireEvent.click(screen.getByRole('button', { name: 'Check questions' }));
    expect(await screen.findByText('Same questions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Combine' })).toBeEnabled();

    fireEvent.click(second); // one test left: no check needed, but the old check is gone
    expect(screen.queryByText('Same questions')).toBeNull();
    fireEvent.click(second); // same two tests again, still unchecked
    expect(screen.queryByText('Same questions')).toBeNull();
    expect(screen.getByRole('button', { name: 'Combine' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Check questions' }));
    expect(await screen.findByText('Same questions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Combine' })).toBeEnabled();
    expect(checkQuizParity).toHaveBeenCalledTimes(2);
  });

  it('a create-time 409 shows the parity differences, not only the message', async () => {
    checkQuizParity.mockResolvedValue({ ok: true, differences: [] });
    createQuizGroup.mockRejectedValue(Object.assign(new Error('These tests have different questions'), {
      status: 409,
      differences: [{ assignmentId: 901, title: 'Ep 1 Theory Test *', missing: ['Which is true?'], extra: ['Which is false?'] }],
    }));
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={null} onClose={() => {}} onChanged={() => {}} />);
    await screen.findByRole('checkbox', { name: 'Ep 1 Theory Test *' });
    fireEvent.click(screen.getByRole('button', { name: 'Check questions' }));
    await screen.findByText('Same questions');
    fireEvent.click(screen.getByRole('button', { name: 'Combine' }));
    expect(await screen.findByText(/Which is false\?/)).toBeInTheDocument();
    expect(screen.getByText(/Missing: Which is true\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Combine' })).toBeDisabled();
  });

  it('sends the trimmed quiz name', async () => {
    checkQuizParity.mockResolvedValue({ ok: true, differences: [] });
    createQuizGroup.mockResolvedValue({ group: { id: 7 } });
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={null} onClose={() => {}} onChanged={() => {}} />);
    await screen.findByRole('checkbox', { name: 'Ep 1 Theory Test *' });
    fireEvent.click(screen.getByRole('button', { name: 'Check questions' }));
    await screen.findByText('Same questions');
    fireEvent.change(screen.getByLabelText('Quiz name'), { target: { value: '  Ep 1 Quiz  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Combine' }));
    await waitFor(() => expect(createQuizGroup).toHaveBeenCalledWith({ courseId: 5, assignmentIds: ['900', '901'], title: 'Ep 1 Quiz' }));
  });

  it('clears the candidates and ticks while a reopened modal loads', async () => {
    const { rerender } = render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={null} onClose={() => {}} onChanged={() => {}} />);
    await screen.findByRole('checkbox', { name: 'Ep 1 Theory Test *' });
    const pending = deferred();
    getQuizCandidates.mockReturnValueOnce(pending.promise);
    rerender(<QuizSetupModal open={false} courseId={5} currentAssignment={CURRENT} group={null} onClose={() => {}} onChanged={() => {}} />);
    rerender(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={null} onClose={() => {}} onChanged={() => {}} />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    await act(async () => { pending.resolve(CANDIDATES); });
    expect(await screen.findByRole('checkbox', { name: 'Ep 1 Theory Test *' })).toBeChecked();
  });

  it('ignores a candidates response that arrives after the course changed', async () => {
    const first = deferred();
    const second = deferred();
    getQuizCandidates.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={null} onClose={() => {}} onChanged={() => {}} />);
    rerender(<QuizSetupModal open courseId={6} currentAssignment={CURRENT} group={null} onClose={() => {}} onChanged={() => {}} />);
    await act(async () => {
      second.resolve({ tests: [{ id: 9, schoology_assignment_id: '777', title: 'Course six test', suggestedWith: [] }], summatives: [] });
    });
    expect(await screen.findByRole('checkbox', { name: 'Course six test' })).toBeInTheDocument();
    await act(async () => { first.resolve(CANDIDATES); });
    expect(screen.queryByRole('checkbox', { name: 'Ep 1 Theory Test *' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Course six test' })).toBeInTheDocument();
  });

  describe('linked group', () => {
    it('Remove quiz group asks first; only the confirming Remove deletes and clears the group', async () => {
      deleteQuizGroup.mockResolvedValue({});
      const onChanged = vi.fn();
      render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={LINKED} onClose={() => {}} onChanged={onChanged} />);
      fireEvent.click(screen.getByRole('button', { name: 'Remove quiz group' }));
      expect(screen.getByText('Remove the quiz group? Loaded results are removed; Schoology is not changed.')).toBeInTheDocument();
      expect(deleteQuizGroup).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(deleteQuizGroup).toHaveBeenCalledWith(7));
      expect(onChanged).toHaveBeenCalledWith(null);
    });

    it('Unlink calls linkQuizResult with null, reports the returned group, and shows Not linked', async () => {
      const unlinked = { ...LINKED, result: null };
      linkQuizResult.mockResolvedValue({ group: unlinked });
      const onChanged = vi.fn();
      render(<Harness initial={LINKED} onChanged={onChanged} />);
      expect(screen.getByRole('combobox', { name: 'Result task' })).toHaveValue('950');
      fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
      await waitFor(() => expect(linkQuizResult).toHaveBeenCalledWith(7, null));
      expect(onChanged).toHaveBeenCalledWith(unlinked);
      expect(screen.getByRole('combobox', { name: 'Result task' })).toHaveValue('');
      expect(screen.getByRole('option', { name: 'Not linked' }).selected).toBe(true);
    });

    it('Link stays disabled on the current link and on Not linked', async () => {
      render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={LINKED} onClose={() => {}} onChanged={() => {}} />);
      await screen.findByRole('option', { name: 'Ep 1 Theory Test - Result (S)' });
      expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled();
      fireEvent.change(screen.getByRole('combobox', { name: 'Result task' }), { target: { value: '' } });
      expect(screen.getByRole('combobox', { name: 'Result task' })).toHaveValue('');
      expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled();
    });

    it('a new linked result replaces an earlier local selection', async () => {
      const other = { ...LINKED, result: { schoology_assignment_id: '960', title: 'Other result' } };
      const { rerender } = render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={LINKED} onClose={() => {}} onChanged={() => {}} />);
      await screen.findByRole('option', { name: 'Ep 1 Theory Test - Result (S)' });
      fireEvent.change(screen.getByRole('combobox', { name: 'Result task' }), { target: { value: '' } });
      rerender(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={other} onClose={() => {}} onChanged={() => {}} />);
      expect(screen.getByRole('combobox', { name: 'Result task' })).toHaveValue('960');
    });
  });
});

describe('QuizSetupModal - comment template', () => {
  const WITH_TEMPLATE = { ...LINKED, comment_template: null, default_comment_template: 'Multiple choice: {mcq_percent}%\n{impression}' };

  it('shows the default, lists the placeholders, saves an edit and stays open', async () => {
    const onUpdated = vi.fn();
    setQuizTemplate.mockResolvedValue({ group: { ...WITH_TEMPLATE, comment_template: 'Score {mcq_percent}%\n{impression}' } });
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={WITH_TEMPLATE} onClose={() => {}} onChanged={() => {}} onUpdated={onUpdated} />);
    const box = await screen.findByRole('textbox', { name: 'Overall comment template' });
    expect(box.value).toBe('Multiple choice: {mcq_percent}%\n{impression}');
    expect(screen.getByText(/\{mcq_correct\}/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'Score {mcq_percent}%\n{impression}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(setQuizTemplate).toHaveBeenCalledWith(7, 'Score {mcq_percent}%\n{impression}'));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ comment_template: 'Score {mcq_percent}%\n{impression}' }));
  });

  it('shows a refused template', async () => {
    setQuizTemplate.mockRejectedValue(new Error('Unknown placeholder: {score}'));
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={WITH_TEMPLATE} onClose={() => {}} onChanged={() => {}} onUpdated={() => {}} />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Overall comment template' }), { target: { value: '{score}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('Unknown placeholder: {score}')).toBeInTheDocument();
  });

  it('Reset to default saves an empty template', async () => {
    setQuizTemplate.mockResolvedValue({ group: WITH_TEMPLATE });
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={{ ...WITH_TEMPLATE, comment_template: 'Hi {impression}' }} onClose={() => {}} onChanged={() => {}} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(setQuizTemplate).toHaveBeenCalledWith(7, ''));
  });

  it('no editor for an unlinked group', async () => {
    render(<QuizSetupModal open courseId={5} currentAssignment={CURRENT} group={{ ...GROUP, default_comment_template: '{impression}' }} onClose={() => {}} onChanged={() => {}} onUpdated={() => {}} />);
    await screen.findByText(/Result task/);
    expect(screen.queryByRole('textbox', { name: 'Overall comment template' })).not.toBeInTheDocument();
  });
});
