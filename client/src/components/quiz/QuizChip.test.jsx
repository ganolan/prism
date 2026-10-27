import { it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QuizChip from './QuizChip.jsx';

const members = [{ id: 1, schoology_assignment_id: '900', title: 'Ep 1' }, { id: 2, schoology_assignment_id: '901', title: 'Ep 1 *' }];
const linked = { id: 7, title: 'Ep 1', result: { schoology_assignment_id: '950', title: 'Ep 1 - Result (S)' }, members };

const popText = () => document.querySelector('.quiz-chip-pop')?.textContent;

it('names the number of linked tests, with the result task and the titles on hover (no native title)', () => {
  render(<QuizChip group={linked} />);
  const chip = screen.getByRole('button', { name: /2 linked tests/ });
  expect(chip).not.toHaveAttribute('title');
  fireEvent.mouseEnter(chip);
  expect(document.querySelector('.help-pop')).not.toBeNull();
  expect(popText()).toBe('Result task: Ep 1 - Result (S)Ep 1Ep 1 *');
  fireEvent.mouseLeave(chip);
  expect(screen.queryByRole('list')).toBeNull();
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

it('a tap (hover, then click) keeps the list open; leaving does not close a clicked list', () => {
  render(<QuizChip group={linked} />);
  const chip = screen.getByRole('button', { name: /2 linked tests/ });
  fireEvent.mouseEnter(chip);
  fireEvent.click(chip);
  fireEvent.mouseLeave(chip);
  expect(screen.getByRole('list')).toBeInTheDocument();
});

it('a group without a result task reads "combined"; one test is singular', () => {
  const { rerender } = render(<QuizChip group={{ ...linked, result: null }} />);
  fireEvent.mouseEnter(screen.getByRole('button', { name: /2 combined tests/ }));
  expect(popText()).toBe('Combined tests, not linked to a result taskEp 1Ep 1 *');
  rerender(<QuizChip group={{ ...linked, members: [members[0]] }} />);
  expect(screen.getByRole('button', { name: /1 linked test$/ })).toBeInTheDocument();
});

it('renders nothing without a group', () => {
  const { container } = render(<QuizChip group={null} />);
  expect(container).toBeEmptyDOMElement();
});

it('opens the list from the chip\'s left edge, so a chip near the sidebar does not push it under', () => {
  render(<QuizChip group={linked} />);
  const chip = screen.getByRole('button', { name: /2 linked tests/ });
  chip.getBoundingClientRect = () => ({ left: 100, width: 80, bottom: 20, top: 0, right: 180, height: 20 });
  fireEvent.click(chip);
  const pop = document.querySelector('.quiz-chip-pop');
  expect(pop.style.left).toBe('100px');
  expect(pop.style.transform).toBe('none');
});
