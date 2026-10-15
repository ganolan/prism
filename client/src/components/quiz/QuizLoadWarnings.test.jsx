import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import QuizLoadWarnings from './QuizLoadWarnings.jsx';

const clean = { parity_status: 'ok', parity_detail: null, load_summary: { attempts: 2, notTaken: 1, failed: [], unknownUids: [], mismatches: [], multipleAttempts: [] } };

describe('QuizLoadWarnings', () => {
  it('renders nothing for no group, a never-loaded group, or a clean load', () => {
    const a = render(<QuizLoadWarnings group={null} />);
    expect(a.container.innerHTML).toBe('');
    const b = render(<QuizLoadWarnings group={{ parity_status: null, parity_detail: null, load_summary: null }} />);
    expect(b.container.innerHTML).toBe('');
    const c = render(<QuizLoadWarnings group={clean} />);
    expect(c.container.innerHTML).toBe('');
  });

  it('lists each copy mismatch under a lead line', () => {
    render(<QuizLoadWarnings group={{ ...clean, parity_status: 'mismatch', parity_detail: ['Question 4: a different key', 'Question 7: different options'] }} />);
    expect(screen.getByText('The combined tests differ:')).toBeInTheDocument();
    expect(screen.getByText('Question 4: a different key')).toBeInTheDocument();
    expect(screen.getByText('Question 7: different options')).toBeInTheDocument();
    expect(screen.getByTestId('quiz-load-warnings')).toHaveClass('alert', 'alert-warning');
  });

  it('counts students who could not be loaded and gives each reason, by name when known', () => {
    const group = { ...clean, load_summary: { ...clean.load_summary, failed: [{ uid: '701', reason: 'attempt page HTTP 500' }, { uid: '999', reason: 'rubric HTTP 503' }, { uid: null, reason: 'results page for "T" HTTP 500' }] } };
    render(<QuizLoadWarnings group={group} students={[{ schoology_uid: '701', first_name: 'Ada', last_name: 'Lovelace' }]} />);
    expect(screen.getByText('3 students could not be loaded:')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace: attempt page HTTP 500')).toBeInTheDocument();
    expect(screen.getByText('Schoology user 999: rubric HTTP 503')).toBeInTheDocument();
    expect(screen.getByText('results page for "T" HTTP 500')).toBeInTheDocument();
  });

  it('says how many students Prism does not know and what to do', () => {
    render(<QuizLoadWarnings group={{ ...clean, load_summary: { ...clean.load_summary, unknownUids: ['5'] } }} />);
    expect(screen.getByText('1 student Prism does not know. Sync the course, then load again.')).toBeInTheDocument();
  });

  it('says how many students have more than one attempt and which one was used', () => {
    render(<QuizLoadWarnings group={{ ...clean, load_summary: { ...clean.load_summary, multipleAttempts: ['1', '2'] } }} />);
    expect(screen.getByText('2 students have more than one attempt. Prism used the latest.')).toBeInTheDocument();
  });

  it('shows every kind together in one alert', () => {
    render(<QuizLoadWarnings group={{ parity_status: 'mismatch', parity_detail: ['Question 1: a different key'],
      load_summary: { failed: [{ uid: '1', reason: 'x' }], unknownUids: ['2'], multipleAttempts: ['3'] } }} />);
    expect(screen.getAllByTestId('quiz-load-warnings')).toHaveLength(1);
    expect(screen.getByText('1 student could not be loaded:')).toBeInTheDocument();
  });
});
