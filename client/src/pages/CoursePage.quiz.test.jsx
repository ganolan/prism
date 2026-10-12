import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
