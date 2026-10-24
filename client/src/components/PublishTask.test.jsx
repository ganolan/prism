import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import PublishToggle from './PublishTask.jsx';
import { setAssessmentPublished } from '../services/api.js';

vi.mock('../services/api.js', () => ({ setAssessmentPublished: vi.fn() }));

const TASK = { id: 50, title: 'Paper Test (F)', published: 0 };
beforeEach(() => vi.clearAllMocks());

describe('PublishToggle (#184)', () => {
  it('shows the state and asks before it writes', () => {
    render(<PublishToggle courseId={4} assignment={TASK} />);
    const toggle = screen.getByRole('switch', { name: 'Unpublished' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText('Students see it immediately.')).toBeInTheDocument();
    expect(setAssessmentPublished).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Students see it immediately.')).not.toBeInTheDocument();
  });

  it('the confirm is a popover at the switch: Publish has focus; Escape or a click outside closes it (24 Oct 2026)', () => {
    render(<><PublishToggle courseId={4} assignment={TASK} /><p>Elsewhere</p></>);
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    const pop = screen.getByRole('group', { name: 'Publish "Paper Test (F)" on Schoology' });
    expect(pop).toHaveClass('publish-pop');
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    fireEvent.mouseDown(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(setAssessmentPublished).not.toHaveBeenCalled();
  });

  it('publishes, and reports the state Schoology read back', async () => {
    const onChange = vi.fn();
    vi.mocked(setAssessmentPublished).mockResolvedValue({ assignmentId: 50, published: 1, changed: true });
    render(<PublishToggle courseId={4} assignment={TASK} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish' })); });
    expect(setAssessmentPublished).toHaveBeenCalledWith(4, 50, 1);
    expect(onChange).toHaveBeenCalledWith(1);
    expect(screen.getByRole('status')).toHaveTextContent('Published on Schoology (checked).');
  });

  it('a published task offers Unpublish, with the warning', async () => {
    vi.mocked(setAssessmentPublished).mockResolvedValue({ published: 0 });
    render(<PublishToggle courseId={4} assignment={{ ...TASK, published: 1 }} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Published' }));
    expect(screen.getByText('Students stop seeing it immediately.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unpublish' })); });
    expect(setAssessmentPublished).toHaveBeenCalledWith(4, 50, 0);
  });

  it('a refusal is shown, and nothing is reported as changed', async () => {
    const onChange = vi.fn();
    vi.mocked(setAssessmentPublished).mockRejectedValue(new Error('Schoology refused the change (HTTP 403)'));
    render(<PublishToggle courseId={4} assignment={TASK} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish' })); });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Couldn't publish "Paper Test \(F\)": Schoology refused the change/)).toBeInTheDocument();
  });
});
