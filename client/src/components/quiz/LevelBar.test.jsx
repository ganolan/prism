import { it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LevelBar, { levelShort } from './LevelBar.jsx';

const levels = [{ name: 'Exhibiting Depth', count: 2 }, { name: 'Developing', count: 4 }, { name: 'Not marked', count: 1 }];

it('one segment per level, best first, sized by count, with the full counts as its name', () => {
  render(<LevelBar levels={levels} />);
  const bar = screen.getByRole('img', { name: 'Exhibiting Depth 2, Developing 4, Not marked 1' });
  const segs = [...bar.querySelectorAll('.level-seg')];
  expect(segs.map(s => s.getAttribute('title'))).toEqual(['Exhibiting Depth: 2', 'Developing: 4', 'Not marked: 1']);
  expect(segs.map(s => s.style.flexGrow)).toEqual(['2', '4', '1']);
});

it('labels a wide enough segment with its short level and count, and shows a legend', () => {
  render(<LevelBar levels={levels} legend />);
  expect(screen.getByText('ED 2')).toBeInTheDocument();
  expect(screen.getByText('D 4')).toBeInTheDocument();
  expect(screen.getByText('Exhibiting Depth 2')).toBeInTheDocument();
});

it('the mini bar has no labels inside its segments', () => {
  render(<LevelBar levels={levels} mini />);
  expect(screen.queryByText('ED 2')).toBeNull();
});

it('shortens Prism\'s own level names and keeps any other name', () => {
  expect(['Exhibiting Depth', 'Exhibiting', 'Developing', 'Emerging', 'Insufficient Evidence', 'Not marked', 'Proficient'].map(levelShort))
    .toEqual(['ED', 'EX', 'D', 'EM', 'IE', 'Not marked', 'Proficient']);
});

it('renders nothing without levels', () => {
  const { container } = render(<LevelBar levels={[]} />);
  expect(container).toBeEmptyDOMElement();
});
