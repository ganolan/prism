import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import AssessmentFilterBar from './AssessmentFilterBar.jsx';

const LTI = { is_lti_submission: 1, due_date: '2026-06-01' };
const NON_LTI = { is_lti_submission: 0, due_date: '2026-06-01' };
const TOPICS = [{ id: 't1' }];
const students = [
  { scores: { t1: { grade: 'EX' } }, grade_comment: 'x', exception: 0, comment_status: 1, lti_submission_state: 'submitted', resubmit_flag: null },
  { scores: {}, grade_comment: '', exception: 0, comment_status: 0, lti_submission_state: 'not_started', resubmit_flag: null },
];

// The descriptive pills sit under the collapsed Refine section.
const openRefine = () => fireEvent.click(screen.getByRole('button', { name: /Refine/ }));

describe('AssessmentFilterBar', () => {
  it('renders three status pills for an LTI assignment', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set()} onToggle={() => {}} />);
    openRefine();
    expect(screen.getByRole('button', { name: /Submitted/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /In Progress/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Not Started/ })).toBeInTheDocument();
  });
  it('renders Submitted + Unsubmitted status pills for a non-LTI assignment', () => {
    render(<AssessmentFilterBar students={students} assignment={NON_LTI} topics={TOPICS} active={new Set()} onToggle={() => {}} />);
    openRefine();
    expect(screen.getByRole('button', { name: /^Submitted/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Unsubmitted/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /In Progress/ })).toBeNull();
  });
  it('shows a per-pill count', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set()} onToggle={() => {}} />);
    openRefine();
    expect(screen.getByRole('button', { name: /Submitted/ })).toHaveTextContent('1');
  });
  it('calls onToggle with the pill id on click', () => {
    const onToggle = vi.fn();
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set()} onToggle={onToggle} />);
    openRefine();
    fireEvent.click(screen.getByRole('button', { name: /Partially graded/ }));
    expect(onToggle).toHaveBeenCalledWith('partial');
  });
  it('marks an active pill via aria-pressed', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set(['submitted'])} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /Submitted/ })).toHaveAttribute('aria-pressed', 'true');
  });
  it('opens Refine by itself when one of its pills is active', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set(['submitted'])} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /^Refine\s*1/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows Needs action and Watch pills only for reasons some student has', () => {
    const withLate = [...students, { ...students[1], attention: { handedIn: false, reasons: [{ id: 'late', daysLate: 2, tone: 'green' }] } }];
    render(<AssessmentFilterBar students={withLate} assignment={LTI} topics={TOPICS} active={new Set()} onToggle={() => {}} />);
    const action = screen.getByRole('group', { name: 'Needs action' });
    expect(within(action).getByText('Nothing needs action')).toBeInTheDocument();
    expect(within(action).queryByRole('button')).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Watch' })).getByRole('button', { name: /^Late1/ })).toBeInTheDocument();
  });

  it('names an empty row and offers Clear all while anything is selected', () => {
    const onClear = vi.fn();
    render(<AssessmentFilterBar students={[]} assignment={LTI} topics={TOPICS} active={new Set(['late'])} onToggle={() => {}} onClear={onClear} />);
    expect(screen.getByText('Nothing needs action')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClear).toHaveBeenCalled();
  });
  it('hides a reason pill no student has, even while it is selected', () => {
    const toGrade = [{ ...students[0], scores: {}, grade_comment: '', attention: { handedIn: true, reasons: [] } }];
    render(<AssessmentFilterBar students={toGrade} assignment={LTI} topics={TOPICS} active={new Set(['to_grade', 'draft'])} onToggle={() => {}} />);
    const action = screen.getByRole('group', { name: 'Needs action' });
    expect(within(action).getByRole('button', { name: /^To grade1/ })).toBeInTheDocument();
    expect(within(action).queryByRole('button', { name: /Draft not published/ })).toBeNull();
  });

  it('the group pill shows none / some / all, selects every pill in its row, then clears the whole row', () => {
    const many = [
      { ...students[0], scores: {}, grade_comment: '', attention: { handedIn: true, reasons: [] } },
      { ...students[1], resubmitted: true, attention: { handedIn: false, reasons: [] } },
    ];
    const onSetMany = vi.fn();
    const bar = (active) => <AssessmentFilterBar students={many} assignment={LTI} topics={TOPICS} active={new Set(active)} onToggle={() => {}} onSetMany={onSetMany} />;
    const { rerender } = render(bar([]));
    const group = screen.getByRole('button', { name: /^Needs action\s*2$/ }); // 2 students have a Needs action reason
    expect(group).toHaveAttribute('aria-pressed', 'false');
    rerender(bar(['to_grade']));
    expect(group).toHaveAttribute('aria-pressed', 'mixed');
    fireEvent.click(group);
    expect(onSetMany).toHaveBeenLastCalledWith(['to_grade', 'resubmitted'], true);
    rerender(bar(['to_grade', 'resubmitted']));
    expect(group).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(group);
    const [ids, on] = onSetMany.mock.lastCall;
    expect(on).toBe(false);
    expect(ids).toEqual(expect.arrayContaining(['to_grade', 'resubmitted', 'draft', 'feedback_hidden', 'referral']));
  });

  it('states how many students show; Refine sits at the end of the Watch row', () => {
    render(<AssessmentFilterBar students={students} assignment={LTI} topics={TOPICS} active={new Set(['submitted'])} onToggle={() => {}} shown={1} total={2} />);
    expect(screen.getByText(/Showing/)).toHaveTextContent('Showing 1 of 2 students');
    expect(within(screen.getByRole('group', { name: 'Watch' })).getByRole('button', { name: /^Refine/ })).toBeInTheDocument();
  });

});

