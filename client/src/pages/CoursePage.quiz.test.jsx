import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssessmentsView } from './CoursePage.jsx';
import { getQuizGroups } from '../services/api.js';

vi.mock('../services/api.js', async (orig) => ({ ...(await orig()), getQuizGroups: vi.fn() }));

it('folds member tests under the canonical row and shows the chip', async () => {
  getQuizGroups.mockResolvedValue({ groups: [{ id: 7, title: 'Ep 1', result: { schoology_assignment_id: '950', title: 'Ep 1 - Result (S)' },
    members: [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1' }, { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *' }], canonical_schoology_id: '950' }] });
  const data = { folders: [], assignments: [
    { id: 1, schoology_assignment_id: '900', title: 'Ep 1', aligned: 0, is_test: 1 },
    { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *', aligned: 0, is_test: 1 },
    { id: 3, schoology_assignment_id: '950', title: 'Ep 1 - Result (S)', aligned: 1, is_test: 0 },
  ] };
  render(<MemoryRouter><AssessmentsView data={data} courseId={5} /></MemoryRouter>);
  expect(await screen.findByText(/Linked: Ep 1, Ep 1 \*/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Ep 1 *' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Ep 1 - Result (S)' })).toBeInTheDocument();
});

describe('make-up chips of folded member tests', () => {
  const group = { id: 7, title: 'Ep 1', result: { schoology_assignment_id: '950', title: 'Ep 1 - Result (S)' },
    members: [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1' }, { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *' }], canonical_schoology_id: '950' };
  const data = { folders: [], assignments: [
    { id: 1, schoology_assignment_id: '900', title: 'Ep 1', aligned: 0, is_test: 1, makeup_ignored: 0 },
    { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *', aligned: 0, is_test: 1, makeup_ignored: 1 },
    { id: 3, schoology_assignment_id: '950', title: 'Ep 1 - Result (S)', aligned: 1, is_test: 0 },
  ] };

  it('shows each folded member\'s chip on the canonical row, labelled with its title', async () => {
    getQuizGroups.mockResolvedValue({ groups: [group] });
    render(<MemoryRouter><AssessmentsView data={data} courseId={5} onToggleMakeUp={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: /Make-ups \(Ep 1\): tracked/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Make-ups \(Ep 1 \*\): ignored/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a folded chip toggles with the member\'s own assignment row', async () => {
    getQuizGroups.mockResolvedValue({ groups: [group] });
    const toggle = vi.fn().mockResolvedValue();
    render(<MemoryRouter><AssessmentsView data={data} courseId={5} onToggleMakeUp={toggle} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Make-ups \(Ep 1 \*\)/ }));
    expect(toggle).toHaveBeenCalledWith(data.assignments[1]);
  });

  it('no chips on a non-live course (no onToggleMakeUp)', async () => {
    getQuizGroups.mockResolvedValue({ groups: [group] });
    render(<MemoryRouter><AssessmentsView data={data} courseId={5} /></MemoryRouter>);
    await screen.findByText(/Linked:/);
    expect(screen.queryByRole('button', { name: /Make-ups/ })).toBeNull();
  });

  it('with no result task the canonical member keeps its own chip and the other member adds one', async () => {
    getQuizGroups.mockResolvedValue({ groups: [{ ...group, result: null, canonical_schoology_id: '900' }] });
    render(<MemoryRouter><AssessmentsView data={data} courseId={5} onToggleMakeUp={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Make-ups: tracked' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Make-ups/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Make-ups \(Ep 1 \*\): ignored/ })).toBeInTheDocument();
  });
});
