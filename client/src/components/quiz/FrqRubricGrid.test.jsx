import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import FrqRubricGrid from './FrqRubricGrid.jsx';

const RUBRIC = { id: 'r1', rows: [{ id: '146', title: 'Content Knowledge', levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth:\n\nEvery part correct.' },
  { points: 2, name: 'Developing', descriptionHtml: 'Developing:\n\nOne part correct.' }] }] };

it('a button per level with its description, the final cell pressed', () => {
  render(<FrqRubricGrid rubric={RUBRIC} final={{ 146: 2 }} onSelect={() => {}} />);
  expect(screen.getByRole('button', { name: 'Content Knowledge: Developing' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Content Knowledge: Exhibiting Depth' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByText('Every part correct.')).toBeInTheDocument();
});

it('marks the AI cell and Schoology\'s cell', () => {
  render(<FrqRubricGrid rubric={RUBRIC} suggested={{ 146: 4 }} schoology={{ 146: 2 }} onSelect={() => {}} />);
  const ed = screen.getByRole('button', { name: 'Content Knowledge: Exhibiting Depth' });
  expect(ed).toHaveClass('frq-cell--ai');
  expect(within(screen.getByRole('button', { name: 'Content Knowledge: Developing' })).getByLabelText("Schoology's current mark")).toBeInTheDocument();
});

it('clicking a cell selects it', () => {
  const onSelect = vi.fn();
  render(<FrqRubricGrid rubric={RUBRIC} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: 'Content Knowledge: Exhibiting Depth' }));
  expect(onSelect).toHaveBeenCalledWith('146', 4);
});
