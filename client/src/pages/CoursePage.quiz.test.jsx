import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  expect(await screen.findByRole('button', { name: /2 linked tests/ })).toBeInTheDocument();
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

  it('shows each folded member\'s chip on the canonical row, labelled by its place in the group', async () => {
    getQuizGroups.mockResolvedValue({ groups: [group] });
    render(<MemoryRouter><AssessmentsView data={data} courseId={5} onToggleMakeUp={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Make-ups (Test 1): tracked' })).toHaveAttribute('aria-pressed', 'true');
    const second = screen.getByRole('button', { name: 'Make-ups (Test 2): ignored' });
    expect(second).toHaveAttribute('aria-pressed', 'false');
    expect(second.getAttribute('title')).toContain('Ep 1 *');
  });

  it('a folded chip toggles with the member\'s own assignment row', async () => {
    getQuizGroups.mockResolvedValue({ groups: [group] });
    const toggle = vi.fn().mockResolvedValue();
    render(<MemoryRouter><AssessmentsView data={data} courseId={5} onToggleMakeUp={toggle} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Make-ups \(Test 2\)/ }));
    expect(toggle).toHaveBeenCalledWith(data.assignments[1]);
  });

  it('no chips on a non-live course (no onToggleMakeUp)', async () => {
    getQuizGroups.mockResolvedValue({ groups: [group] });
    render(<MemoryRouter><AssessmentsView data={data} courseId={5} /></MemoryRouter>);
    await screen.findByRole('button', { name: /2 linked tests/ });
    expect(screen.queryByRole('button', { name: /Make-ups/ })).toBeNull();
  });

  it('with no result task the canonical member\'s chip is Test 1 and the other member adds Test 2', async () => {
    getQuizGroups.mockResolvedValue({ groups: [{ ...group, result: null, canonical_schoology_id: '900' }] });
    render(<MemoryRouter><AssessmentsView data={data} courseId={5} onToggleMakeUp={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Make-ups (Test 1): tracked' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Make-ups/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Make-ups (Test 2): ignored' })).toBeInTheDocument();
  });
});

describe('an unpublished result task', () => {
  const group = { id: 7, title: 'Ep 1', result: { schoology_assignment_id: '950', title: 'Ep 1 - Result (S)' },
    members: [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1' }, { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *' }], canonical_schoology_id: '950' };
  const withPublished = (p900, p901) => ({ folders: [], assignments: [
    { id: 1, schoology_assignment_id: '900', title: 'Ep 1', aligned: 0, is_test: 1, published: p900 },
    { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *', aligned: 0, is_test: 1, published: p901 },
    { id: 3, schoology_assignment_id: '950', title: 'Ep 1 - Result (S)', aligned: 1, is_test: 0, published: 0 },
  ] });

  it('keeps the folded row in the default list while a member test is published', async () => {
    getQuizGroups.mockResolvedValue({ groups: [group] });
    render(<MemoryRouter><AssessmentsView data={withPublished(1, 0)} courseId={5} /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Ep 1 - Result (S)' })).toBeInTheDocument();
    expect(screen.getByTitle('Not published on Schoology')).toBeInTheDocument();
  });

  it('hides the folded row by default when no member test is published either', async () => {
    getQuizGroups.mockResolvedValue({ groups: [group] });
    render(<MemoryRouter><AssessmentsView data={withPublished(0, 0)} courseId={5} /></MemoryRouter>);
    await waitFor(() => expect(getQuizGroups).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Ep 1 *' })).toBeNull());
    expect(screen.queryByRole('link', { name: 'Ep 1 - Result (S)' })).toBeNull();
  });
});
