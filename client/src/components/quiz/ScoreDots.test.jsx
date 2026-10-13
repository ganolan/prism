import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ScoreDots, { STORAGE_KEY } from './ScoreDots.jsx';

const S = (name, correct, total = 20) => ({ student_id: name.length, name, correct, total, percent: Math.round((100 * correct) / total) });
const students = [S('Ana Lee', 13), S('Ben Ho', 17), S('Cy Ng', 17), S('Di Wu', 20)];

beforeEach(() => { try { localStorage.clear(); } catch { /* storage may be unavailable */ } });

describe('ScoreDots', () => {
  it('draws one dot per student and summarises the scores for screen readers', () => {
    const { container } = render(<ScoreDots students={students} />);
    expect(container.querySelectorAll('circle.score-dot')).toHaveLength(4);
    expect(screen.getByRole('img', { name: 'MCQ scores of 4 students: median 85%, range 65 to 100%' })).toBeInTheDocument();
  });

  it('opens as a dot plot that stacks equal scores in one column', () => {
    const { container } = render(<ScoreDots students={students} />);
    expect(screen.getByRole('button', { name: 'Dots' })).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('rect.score-box')).toBeNull();
    const [ben, cy] = [...container.querySelectorAll('circle.score-dot')].filter(c => c.getAttribute('aria-label').includes('17/20'));
    expect(ben.getAttribute('cx')).toBe(cy.getAttribute('cx'));
    expect(ben.getAttribute('cy')).not.toBe(cy.getAttribute('cy'));
  });

  it('switches to box and whiskers with the dots, and remembers the choice', () => {
    const { container, unmount } = render(<ScoreDots students={students} />);
    fireEvent.click(screen.getByRole('button', { name: 'Box' }));
    expect(container.querySelector('rect.score-box')).not.toBeNull();
    expect(container.querySelectorAll('circle.score-dot')).toHaveLength(4);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('box');
    unmount();
    render(<ScoreDots students={students} />);
    expect(screen.getByRole('button', { name: 'Box' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the student\'s name and score when a dot is hovered', () => {
    const { container } = render(<ScoreDots students={students} />);
    const dot = [...container.querySelectorAll('circle.score-dot')].find(c => c.getAttribute('aria-label').startsWith('Di Wu'));
    fireEvent.mouseEnter(dot);
    expect(screen.getByText('Di Wu')).toBeInTheDocument();
    expect(screen.getByText('20/20 (100%)')).toBeInTheDocument();
    fireEvent.mouseLeave(dot);
    expect(screen.queryByText('Di Wu')).toBeNull();
  });

  it('renders nothing without students', () => {
    const { container } = render(<ScoreDots students={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
