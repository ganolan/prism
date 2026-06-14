import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AssessmentFilterBar from './AssessmentFilterBar.jsx';

const LTI = { is_lti_submission: 1, due_date: '2026-06-01' };
const NON_LTI = { is_lti_submission: 0, due_date: '2026-06-01' };
const TOPICS = [{ id: 't1' }];
const students = [
  { scores: { t1: { grade: 'EX' } }, grade_comment: 'x', exception: 0, comment_status: 1, lti_submission_state: 'submitted', review_flag: null, resubmit_flag: null },
  { scores: {}, grade_comment: '', exception: 0, comment_status: 0, lti_submission_state: 'not_started', review_flag: null, resubmit_flag: null },
];

describe('AssessmentFilterBar', () => {
  it('renders three status pills for an LTI assignment', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set()} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /Submitted/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /In Progress/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Not Started/ })).toBeInTheDocument();
  });
  it('renders only the Submitted status pill for a non-LTI assignment', () => {
    render(<AssessmentFilterBar students={students} assignment={NON_LTI} topics={TOPICS} active={new Set()} onToggle={() => {}} />);
    expect(screen.queryByRole('button', { name: /In Progress/ })).toBeNull();
  });
  it('shows a per-pill count', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set()} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /Submitted/ })).toHaveTextContent('1');
  });
  it('calls onToggle with the pill id on click', () => {
    const onToggle = vi.fn();
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set()} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /Partially graded/ }));
    expect(onToggle).toHaveBeenCalledWith('partial');
  });
  it('marks an active pill via aria-pressed', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set(['submitted'])} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /Submitted/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
