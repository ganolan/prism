import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ExceptionChip from './ExceptionChip.jsx';
import AssignmentFeedback from './AssignmentFeedback.jsx';
import { gradeLabel } from '../lib/gradeLabel.js';

describe('ExceptionChip', () => {
  it.each([
    [1, 'Exc', 'excused', 'Excused: left out of the grade'],
    [2, 'Inc', 'incomplete', 'Incomplete (set in Schoology)'],
    [3, 'Miss', 'missing', 'Missing (set in Schoology): counts as zero'],
  ])('exception %i is the chip "%s" with its hover text', (exception, text, tone, title) => {
    render(<ExceptionChip exception={exception} />);
    const chip = screen.getByText(text);
    expect(chip).toHaveClass('exception-chip', `exception-chip--${tone}`);
    expect(chip).toHaveAttribute('title', title);
  });

  it('Excused adds the saved level to its title when Prism holds a saved grade', () => {
    render(<ExceptionChip exception={1} savedLevel="Exhibiting" />);
    expect(screen.getByText('Exc')).toHaveAttribute('title', 'Excused: left out of the grade. Grade saved in Prism: Exhibiting');
  });

  it('only Excused mentions a saved level', () => {
    render(<ExceptionChip exception={3} savedLevel="Exhibiting" />);
    expect(screen.getByText('Miss')).toHaveAttribute('title', 'Missing (set in Schoology): counts as zero');
  });

  it('renders nothing for a non-exception value', () => {
    const { container } = render(<ExceptionChip exception={4} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AssignmentFeedback: the score slot', () => {
  it('shows the chip in the place of the score for an exception', () => {
    render(<AssignmentFeedback score={gradeLabel({ score: 5, exception: 1 })} />);
    expect(screen.getByText('Score:')).toBeInTheDocument();
    expect(screen.getByText('Exc')).toHaveClass('exception-chip--excused');
    expect(screen.queryByText('Excused')).toBeNull();
  });
});
