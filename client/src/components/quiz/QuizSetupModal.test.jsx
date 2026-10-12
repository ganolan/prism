import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import QuizSetupModal from './QuizSetupModal.jsx';
import { getQuizCandidates, checkQuizParity, createQuizGroup, linkQuizResult } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getQuizCandidates: vi.fn(), checkQuizParity: vi.fn(), createQuizGroup: vi.fn(), linkQuizResult: vi.fn(), deleteQuizGroup: vi.fn(),
}));

const CANDIDATES = {
  tests: [
    { id: 1, schoology_assignment_id: '900', title: 'Ep 1 Theory Test', suggestedWith: ['901'] },
    { id: 2, schoology_assignment_id: '901', title: 'Ep 1 Theory Test *', suggestedWith: ['900'] },
  ],
  summatives: [{ id: 3, schoology_assignment_id: '950', title: 'Ep 1 Theory Test - Result (S)' }],
};

beforeEach(() => { vi.clearAllMocks(); getQuizCandidates.mockResolvedValue(CANDIDATES); });

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
});
