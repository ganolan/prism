import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

  const panel = (name = 'Refer to the academic office?') => screen.getByRole('group', { name });

  it('missing work at the limit: Refer opens the panel (#175); ticked, it writes IE and Missing, refetches, then hands the card the fresh state', async () => {
    const onChange = vi.fn();
    const order = [];
    const beforeWrite = vi.fn(async () => { order.push('settle'); });
    const onSchoologyChange = vi.fn(async () => { order.push('refetch'); });
    api.recordReferral.mockImplementation(async () => { order.push('refer'); return { id: 3, schoology: { topics: 2, missing: true } }; });
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<ReferControl student={student({ late_work: { kind: 'outstanding', tone: 'red' } })} assignmentId={30} panelHost={host}
      onChange={onChange} beforeWrite={beforeWrite} onSchoologyChange={onSchoologyChange} />);
    expect(screen.queryByRole('button', { name: 'Waive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refer' }));
    expect(host).toContainElement(panel());
    expect(api.recordReferral).not.toHaveBeenCalled();
    expect(within(panel()).getByRole('checkbox', { name: 'Also record IE on every topic and mark Missing in Schoology' })).toBeChecked();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Refer' }));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, action: 'referred', schoology: true }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(FRESH));
    expect(order).toEqual(['settle', 'refer', 'refetch']);
    expect(api.getTriagePair).toHaveBeenCalledWith(7, 30);
  });

  it('unticked: Prism only, no settle and no refetch', async () => {
    const beforeWrite = vi.fn();
    const onSchoologyChange = vi.fn();
    render(<ReferControl student={student({ late_work: { kind: 'outstanding', tone: 'red' } })} assignmentId={30}
      beforeWrite={beforeWrite} onSchoologyChange={onSchoologyChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refer' }));
    fireEvent.click(within(panel()).getByRole('checkbox'));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Refer' }));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, action: 'referred', schoology: false }));
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(onSchoologyChange).not.toHaveBeenCalled();
  });

  it('a warning from the write (IE written, Missing not) stays beside the pill', async () => {
    api.recordReferral.mockResolvedValue({ id: 3, schoology: { topics: 2, missing: false, warning: 'Missing was not set. Set it from the Flags menu.' } });
    render(<ReferControl student={student({ late_work: { kind: 'outstanding', tone: 'red' } })} assignmentId={30} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refer' }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Refer' }));
    expect(await screen.findByText(/Missing was not set/)).toBeInTheDocument();
  });

  it('handed in late: Refer records at once, Prism only', async () => {
    render(<ReferControl student={student({ late_work: { kind: 'submitted_late', tone: 'red' } })} assignmentId={30} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refer' }));
    await waitFor(() => expect(api.recordReferral).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, action: 'referred' }));
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('Undo on a referral that wrote Missing opens the panel; ticked, it clears in Schoology', async () => {
    render(<ReferControl student={student({ referral: { id: 3, action: 'referred', schoology: { topics: 2, missing: true, cleared: false } } })} assignmentId={30} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(api.undoReferral).not.toHaveBeenCalled();
    fireEvent.click(within(panel('Undo the referral?')).getByRole('button', { name: 'Undo referral' }));
    await waitFor(() => expect(api.undoReferral).toHaveBeenCalledWith(3, { schoology: true }));
  });

  it('Undo once Missing was cleared since: Prism only, at once', async () => {
    render(<ReferControl student={student({ referral: { id: 3, action: 'referred', schoology: { topics: 2, missing: true, cleared: true } } })} assignmentId={30} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.undoReferral).toHaveBeenCalledWith(3));
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

  it('shows a failed write inline (in the panel, which stays open)', async () => {
    api.recordReferral.mockRejectedValue(new Error('Not at the referral limit yet'));
    render(<ReferControl student={student({ late_work: { kind: 'outstanding', tone: 'red' } })} assignmentId={30} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refer' }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Refer' }));
    expect(await within(panel()).findByText('Not at the referral limit yet')).toBeInTheDocument();
  });
});
