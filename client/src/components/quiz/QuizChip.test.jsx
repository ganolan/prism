import { it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QuizChip from './QuizChip.jsx';

const members = [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1' }, { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *' }];
const linked = { id: 7, title: 'Ep 1', result: { schoology_assignment_id: '950', title: 'Ep 1 - Result (S)' }, members };

it('names the number of linked tests, with the titles on hover', () => {
  render(<QuizChip group={linked} />);
  const chip = screen.getByRole('button', { name: /2 linked tests/ });
  expect(chip).toHaveAttribute('title', 'Result task: Ep 1 - Result (S)\nEp 1\nEp 1 *');
});

it('lists the test titles on click, and hides them on a second click', () => {
  render(<QuizChip group={linked} />);
  const chip = screen.getByRole('button', { name: /2 linked tests/ });
  expect(screen.queryByRole('list')).toBeNull();
  fireEvent.click(chip);
  expect(chip).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual(['Ep 1', 'Ep 1 *']);
  fireEvent.click(chip);
  expect(screen.queryByRole('list')).toBeNull();
});

it('a group without a result task reads "combined"; one test is singular', () => {
  const { rerender } = render(<QuizChip group={{ ...linked, result: null }} />);
  expect(screen.getByRole('button', { name: /2 combined tests/ })).toHaveAttribute('title', 'Combined tests, not linked to a result task\nEp 1\nEp 1 *');
  rerender(<QuizChip group={{ ...linked, members: [members[0]] }} />);
  expect(screen.getByRole('button', { name: /1 linked test$/ })).toBeInTheDocument();
});

it('renders nothing without a group', () => {
  const { container } = render(<QuizChip group={null} />);
  expect(container).toBeEmptyDOMElement();
});
