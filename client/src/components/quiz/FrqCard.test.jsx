import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FrqCard, { stateChips } from './FrqCard.jsx';
import { saveFrqMark } from '../../services/api.js';

vi.mock('../../services/api.js', () => ({ saveFrqMark: vi.fn() }));

const RUBRIC = { id: 'r1', rows: [{ id: '146', title: 'Content Knowledge', levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all' }, { points: 2, name: 'Developing', descriptionHtml: 'Developing: some' }] }] };
const question = { id: 9, position: 21, stem_html: '<p>Explain</p>', max_points: 4, rubric: RUBRIC };
const student = { student_id: 1, name: 'Ana Lee', attempt_id: 55, attempt_url: 'https://schoology.hkis.edu.hk/x', completed_at: '2026-10-09 10:00' };
const suggested = { cells: { 146: 4 }, comment: 'All correct.' };
const view = (over = {}) => ({ state: 'suggested', suggested, final: null, suggestion_revised: false, writeback: { status: null, at: null, error: null }, changed_in_schoology: false, ...over });

beforeEach(() => { vi.clearAllMocks(); });

describe('FrqCard', () => {
  it('shows the sanitized answer, the attempt link, and starts from the suggestion', () => {
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: '<p>because</p><img src=x onerror="alert(1)">', schoology: null, mark: view() }} onSaved={() => {}} />);
    expect(screen.getByText('because')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: /Attempt/ })).toHaveAttribute('href', 'https://schoology.hkis.edu.hk/x');
    expect(screen.getByRole('textbox', { name: 'Comment for Ana Lee' })).toHaveValue('All correct.');
    expect(screen.getByRole('button', { name: 'Content Knowledge: Exhibiting Depth' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('starts from Schoology\'s mark when there is no Prism mark', () => {
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: { cells: { 146: 2 }, comment: 'From Schoology' }, mark: null }} onSaved={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Comment for Ana Lee' })).toHaveValue('From Schoology');
    expect(screen.getByText('In Schoology')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('Accept sends accept and reports the new mark', async () => {
    const mark = view({ state: 'accepted', final: suggested, writeback: { status: 'pending' } });
    saveFrqMark.mockResolvedValue({ mark });
    const onSaved = vi.fn();
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: null, mark: view() }} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(mark));
    expect(saveFrqMark).toHaveBeenCalledWith(7, 55, 21, { action: 'accept' });
  });

  it('Save edit sends the chosen cell and the edited comment', async () => {
    saveFrqMark.mockResolvedValue({ mark: view({ state: 'edited' }) });
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: null, mark: view() }} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Content Knowledge: Developing' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment for Ana Lee' }), { target: { value: 'Part (b) needs more.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    await waitFor(() => expect(saveFrqMark).toHaveBeenCalledWith(7, 55, 21, { action: 'save', cells: { 146: 2 }, comment: 'Part (b) needs more.' }));
  });

  it('shows a failed save and keeps the edit', async () => {
    saveFrqMark.mockRejectedValue(new Error('Choose a level for Content Knowledge'));
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: null, mark: view() }} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(await screen.findByText('Choose a level for Content Knowledge')).toBeInTheDocument();
  });

  it('a revised suggestion offers Keep mine', async () => {
    saveFrqMark.mockResolvedValue({ mark: view() });
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: null, mark: view({ state: 'edited', final: { cells: { 146: 2 }, comment: 'Mine' }, suggestion_revised: true }) }} onSaved={() => {}} />);
    expect(screen.getByText('Revised suggestion')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(saveFrqMark).toHaveBeenCalledWith(7, 55, 21, { action: 'keep' }));
  });

  it('an FRQ without a rubric takes points', () => {
    render(<FrqCard groupId={7} student={student} question={{ ...question, rubric: null, max_points: 5 }} response={{ answer_html: 'x', schoology: null, mark: null }} onSaved={() => {}} />);
    expect(screen.getByRole('spinbutton', { name: 'Points for Ana Lee' })).toHaveAttribute('max', '5');
  });

  it('Copy comment copies the comment', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<FrqCard groupId={7} student={student} question={question} response={{ answer_html: 'x', schoology: null, mark: view() }} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy comment' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('All correct.'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});

describe('stateChips', () => {
  it('names the state, the write-back and a change in Schoology', () => {
    expect(stateChips({ schoology: null, mark: null }).map(c => c.label)).toEqual(['Not marked']);
    expect(stateChips({ mark: view({ state: 'accepted', writeback: { status: 'pending' } }) }).map(c => c.label)).toEqual(['Accepted', 'Waiting to post']);
    expect(stateChips({ mark: view({ state: 'edited', writeback: { status: 'posted' }, changed_in_schoology: true }) }).map(c => c.label)).toEqual(['Edited', 'Posted', 'Changed in Schoology']);
    expect(stateChips({ mark: view({ writeback: { status: 'failed', error: 'x' } }) }).map(c => c.label)).toEqual(['Suggested', 'Post failed']);
  });
});
