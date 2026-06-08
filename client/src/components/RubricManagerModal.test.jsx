import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RubricManagerModal from './RubricManagerModal.jsx';
import { listRubrics, attachRubric, deleteRubric, setRubricMapping, reorderRubricCriteria, rubricExportUrl } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  listRubrics: vi.fn(),
  attachRubric: vi.fn().mockResolvedValue({ unmatched: [] }),
  deleteRubric: vi.fn().mockResolvedValue({ ok: true }),
  setRubricMapping: vi.fn().mockResolvedValue({ ok: true }),
  reorderRubricCriteria: vi.fn().mockResolvedValue({ ok: true }),
  uploadRubricCsv: vi.fn().mockResolvedValue({ id: 7 }),
  rubricTemplateUrl: vi.fn(() => '/api/rubrics/template'),
  rubricExportUrl: vi.fn((id) => `/api/rubrics/${id}/export`),
}));

const TOPICS = [
  { id: 't1', title: 'Visual design', category_title: 'Produce', external_id: 'X1' },
  { id: 't2', title: 'Programming', category_title: 'Produce', external_id: 'X2' },
  { id: 't3', title: 'Critique', category_title: 'Respond', external_id: 'X3' },
];
const ATTACHMENT = {
  id: 55,
  rubric: { id: 9, name: 'AIML U2', criteria: [
    { id: 'c1', position: 1, criterion_name: 'UI/UX', standard_title: 'Visual design', descriptors: { ED: 'Polished' } },
    { id: 'c2', position: 2, criterion_name: 'Code', standard_title: 'Programming', descriptors: { ED: 'Clean' } },
  ] },
  topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }],   // c2 is unmapped
};

function open(props = {}) {
  return render(<RubricManagerModal open onClose={() => {}} courseId="4" assignmentId="8"
    topics={TOPICS} attachment={null} onChanged={vi.fn()} {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  listRubrics.mockResolvedValue([
    { id: 9, name: 'AIML U2', source: 'csv', criteria_count: 2, attachment_count: 1, updated_at: '2026-06-02T00:00:00Z' },
    { id: 3, name: 'Old draft', source: 'csv', criteria_count: 4, attachment_count: 0, updated_at: '2026-05-01T00:00:00Z' },
  ]);
});

describe('RubricManagerModal', () => {
  it('lists library rubrics on the Attach tab and attaches one', async () => {
    const onChanged = vi.fn();
    open({ onChanged });
    expect(await screen.findByText('AIML U2')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Attach' })[1]); // "Old draft"
    await waitFor(() => expect(attachRubric).toHaveBeenCalledWith({ rubricId: 3, courseId: '4', assignmentId: '8' }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('confirms in place before deleting an attached rubric', async () => {
    open();
    await screen.findByText('AIML U2');
    const del = screen.getAllByRole('button', { name: /Delete/ })[0]; // AIML U2, attachment_count 1
    fireEvent.click(del);                       // first click → confirm, no API call
    expect(deleteRubric).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Click to confirm/ }));
    await waitFor(() => expect(deleteRubric).toHaveBeenCalledWith(9));
  });

  it('Map criteria tab persists a topic pick and excludes taken topics', async () => {
    open({ attachment: ATTACHMENT });
    fireEvent.click(screen.getByRole('tab', { name: /Map criteria/ }));
    // c2 (unmapped) select should NOT offer t1 (taken by c1) but should offer t2 & t3
    const select = screen.getByLabelText('Topic for Code');
    const optionValues = [...select.querySelectorAll('option')].map(o => o.value);
    expect(optionValues).toEqual(['', 't2', 't3']);   // "— none —" + unmapped only
    fireEvent.change(select, { target: { value: 't2' } });
    await waitFor(() => expect(setRubricMapping).toHaveBeenCalledWith(55, 'c2', 't2'));
  });

  it('Row order tab reorders criteria', async () => {
    open({ attachment: ATTACHMENT });
    fireEvent.click(screen.getByRole('tab', { name: /Row order/ }));
    fireEvent.click(screen.getByLabelText('Move UI/UX down'));
    await waitFor(() => expect(reorderRubricCriteria).toHaveBeenCalledWith(9, ['c2', 'c1']));
  });

  it('clears a pending delete-confirm when reopened', async () => {
    const { rerender } = render(<RubricManagerModal open onClose={() => {}} courseId="4" assignmentId="8"
      topics={TOPICS} attachment={null} onChanged={vi.fn()} />);
    await screen.findByText('AIML U2');
    fireEvent.click(screen.getAllByRole('button', { name: /Delete/ })[0]); // confirm pending
    expect(screen.getByRole('button', { name: /Click to confirm/ })).toBeInTheDocument();
    rerender(<RubricManagerModal open={false} onClose={() => {}} courseId="4" assignmentId="8"
      topics={TOPICS} attachment={null} onChanged={vi.fn()} />);
    rerender(<RubricManagerModal open onClose={() => {}} courseId="4" assignmentId="8"
      topics={TOPICS} attachment={null} onChanged={vi.fn()} />);
    await screen.findByText('AIML U2');
    expect(screen.queryByRole('button', { name: /Click to confirm/ })).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    open({ onClose });
    await screen.findByText('AIML U2');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('jumps to Map criteria and warns when attach leaves unmatched criteria', async () => {
    attachRubric.mockResolvedValueOnce({ unmatched: ['c2'] });
    open({ attachment: ATTACHMENT });
    await screen.findByText('AIML U2'); // wait for rubric list to load
    fireEvent.click(screen.getAllByRole('button', { name: 'Attach' })[0]);
    expect(await screen.findByText(/couldn’t be auto-matched/)).toBeInTheDocument();
    // switched to the Map tab — the criterion dropdown is visible
    expect(screen.getByLabelText('Topic for Code')).toBeInTheDocument();
  });
});