import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReferControl from './ReferControl.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({ recordReferral: vi.fn(), undoReferral: vi.fn(), getTriagePair: vi.fn() }));

const student = ({ late_work = null, referral = null } = {}) => ({ id: 7, timeline: { referral }, late_work });
const FRESH = { timeline: { referral: { id: 3, action: 'referred' } }, late_work: null };

beforeEach(() => {
  vi.clearAllMocks();
  api.recordReferral.mockResolvedValue({ id: 3 });
  api.undoReferral.mockResolvedValue({ deleted: true });
  api.getTriagePair.mockResolvedValue(FRESH);
});

describe('ReferControl (assessment card)', () => {
  it('nothing before the limit (or with no Late work row)', () => {
    const { container } = render(<ReferControl student={student({ late_work: { kind: 'outstanding', tone: 'amber' } })} assignmentId={30} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('missing work at the limit: Refer only; it records, then hands the card the fresh state', async () => {
    const onChange = vi.fn();
    render(<ReferControl student={student({ late_work: { kind: 'outstanding', tone: 'red' } })} assignmentId={30} onChange={onChange} />);
    expect(screen.queryByRole('button', { name: 'Waive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refer' }));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, action: 'referred' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(FRESH));
    expect(api.getTriagePair).toHaveBeenCalledWith(7, 30);
  });

  it('handed in late past the limit: Refer and Waive; Waive takes a reason in the panel row', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<ReferControl student={student({ late_work: { kind: 'submitted_late', tone: 'red' } })} assignmentId={30} panelHost={host} />);
    fireEvent.click(screen.getByRole('button', { name: 'Waive' }));
    expect(screen.getByRole('button', { name: 'Waive' })).toHaveAttribute('aria-expanded', 'true');
    expect(host).toContainElement(screen.getByLabelText('Waive note')); // drawn in the card's panel row
    fireEvent.change(screen.getByLabelText('Waive note'), { target: { value: 'pre-approved absence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Waive referral' }));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, action: 'waived', note: 'pre-approved absence' }));
  });

  it('once decided: a Referred / Referral waived pill with Undo', async () => {
    const { rerender } = render(<ReferControl student={student({ referral: { id: 3, action: 'referred' } })} assignmentId={30} />);
    expect(screen.getByText('Referred')).toHaveClass('badge-red');
    rerender(<ReferControl student={student({ referral: { id: 4, action: 'waived', note: 'pre-approved' } })} assignmentId={30} />);
    expect(screen.getByText('Referral waived')).toHaveAttribute('title', 'pre-approved');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.undoReferral).toHaveBeenCalledWith(4));
  });

  it('shows a failed write inline', async () => {
    api.recordReferral.mockRejectedValue(new Error('Not at the referral limit yet'));
    render(<ReferControl student={student({ late_work: { kind: 'outstanding', tone: 'red' } })} assignmentId={30} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refer' }));
    expect(await screen.findByText('Not at the referral limit yet')).toBeInTheDocument();
  });
});
