import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GradeScaleHelp, gradeScaleText } from './GradeScale.jsx';

const open = (dot) => { fireEvent.mouseEnter(dot); return document.querySelector('.help-pop'); };

describe('GradeScaleHelp', () => {
  it("opens a wide popover with the course's column: a row per letter, a chip per category", () => {
    render(<GradeScaleHelp numCategories={4} />);
    const pop = open(screen.getByRole('img', { name: /^HKIS letter grade, 4 reporting categories/ }));
    expect(pop).toHaveClass('help-pop--wide');
    expect([...pop.querySelectorAll('.grade-scale__letter')].map((l) => l.textContent)).toEqual(['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'D', 'F']);
    const a = pop.querySelector('.grade-scale__row .grade-scale__combos');
    expect([...a.querySelectorAll('.level-strip')].map((s) => s.textContent)).toEqual(['EDEDEDED', 'EDEDEDEX']);
    expect(pop.textContent).toContain('Other category counts and level score bands: Settings, Grade scale.');
    expect(pop.textContent).not.toContain('Not on the HKIS chart');
  });

  it('marks the combination missing from the HKIS chart with 5 categories', () => {
    render(<GradeScaleHelp numCategories={5} />);
    const pop = open(screen.getByRole('img', { name: /^HKIS letter grade, 5 reporting categories/ }));
    // The popover is aria-hidden (the dot's label carries the text), so find the chip by its label.
    expect(pop.querySelector('[aria-label="1 ED, 1 EX, 2 D, 1 EM (not on the HKIS chart)"]')).not.toBeNull();
    expect(pop.textContent).toContain('* Not on the HKIS chart');
  });

  it('states the whole column in its label, for screen readers and agents', () => {
    expect(gradeScaleText(2)).toBe('HKIS letter grade, 2 reporting categories. A: 2 ED. A-: 1 ED, 1 EX. B+: 2 EX. B: 1 ED, 1 D. '
      + 'B-: 1 EX, 1 D. C+: 2 D. C: 1 ED, 1 EM; 1 EX, 1 EM; 1 D, 1 EM. D: 2 EM. F: any IE.');
  });

  it('states that the chart covers 2 to 5 categories when the course has another count', () => {
    render(<GradeScaleHelp numCategories={1} />);
    const pop = open(screen.getByRole('img', { name: /^No letter grade: HKIS's letter grade chart covers 2 to 5 reporting categories, and this course has 1\.$/ }));
    expect(pop.querySelector('.grade-scale')).toBeNull();
  });
});
