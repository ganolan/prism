// The student page's PowerSchool alerts (#117), and the Student Support Summary read
// on demand inside the reveal (#163).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PsAlertReveal from './PsAlertReveal.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

const SUMMARY = { key: 'support_summary', label: 'Support summary', category: 'learning' };
const ALLERGY = { key: 'allergies', label: 'Allergies', category: 'health' };
const ROWS = [
  { category: 'Accommodation Plan', description: 'Yes' },
  { category: 'Support Plan URL', description: 'Open plan', url: 'https://example.org/plan' },
  { category: 'Support Notes', description: '25% extra time on tests' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSupportSummary).mockResolvedValue({ rows: ROWS, readAt: '2026-10-18T10:05:00.000Z' });
});

describe('PsAlertReveal: Student Support Summary', () => {
  it('reads nothing until the alerts are shown', () => {
    render(<PsAlertReveal studentId={7} alerts={[SUMMARY]} />);
    expect(api.getSupportSummary).not.toHaveBeenCalled();
    expect(screen.queryByText('Support Notes')).not.toBeInTheDocument();
  });

  it('shown: reads it for this student and lists every row verbatim, the plan URL as a link', async () => {
    render(<PsAlertReveal studentId={7} alerts={[SUMMARY]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show alerts (1)' }));
    expect(api.getSupportSummary).toHaveBeenCalledWith(7);
    expect(await screen.findByText('25% extra time on tests')).toBeInTheDocument();
    expect(screen.getByText('Accommodation Plan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open plan' })).toHaveAttribute('href', 'https://example.org/plan');
    expect(screen.getByText(/Student Support Summary/)).toBeInTheDocument();
    expect(screen.getByText(/read from PowerSchool 18\/10\/2026/)).toBeInTheDocument();
  });

  it('no Support Summary alert: no read', () => {
    render(<PsAlertReveal studentId={7} alerts={[ALLERGY]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show alerts (1)' }));
    expect(api.getSupportSummary).not.toHaveBeenCalled();
  });

  it('a failed read shows why, and the alerts still show', async () => {
    vi.mocked(api.getSupportSummary).mockRejectedValue(new Error('The Schoology session has expired: log in to Schoology in Settings'));
    render(<PsAlertReveal studentId={7} alerts={[SUMMARY, ALLERGY]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show alerts (2)' }));
    expect(await screen.findByText(/Could not read the Support Summary: The Schoology session has expired/)).toBeInTheDocument();
  });

  it('hiding and showing again reads it again (nothing kept on the page)', async () => {
    render(<PsAlertReveal studentId={7} alerts={[SUMMARY]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show alerts (1)' }));
    await screen.findByText('Support Notes');
    fireEvent.click(screen.getByRole('button', { name: 'Hide alerts' }));
    expect(screen.queryByText('Support Notes')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show alerts (1)' }));
    expect(api.getSupportSummary).toHaveBeenCalledTimes(2);
  });
});
