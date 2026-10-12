import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AttemptLink from './AttemptLink.jsx';

describe('AttemptLink', () => {
  it('links to the attempt, labelled "Attempt", with the completion time in the tooltip', () => {
    render(<AttemptLink link={{ url: 'https://schoology.hkis.edu.hk/assignment/9/assessment_results/student_stats/1/2', completedAt: '2026-10-09 09:31' }} name="Ada Lovelace" />);
    const a = screen.getByRole('link', { name: "Attempt: open Ada Lovelace's test attempt in Schoology" });
    expect(a.getAttribute('href')).toContain('/student_stats/1/2');
    expect(a.getAttribute('title')).toMatch(/09\/10\/2026/);
  });
  it('renders nothing without a link', () => {
    const { container } = render(<AttemptLink link={null} name="Ada" />);
    expect(container.innerHTML).toBe('');
  });
});
