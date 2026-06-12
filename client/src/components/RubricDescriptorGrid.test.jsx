import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RubricDescriptorGrid from './RubricDescriptorGrid.jsx';

// ── Draft cell colour test ────────────────────────────────────────────────────
const draftRows = [{ topic: { id: 't1', title: 'Generates media', category_title: 'Creating', external_id: 'ART.5.1' }, criterion: null }];
const draftLevels = ['ED', 'EX'];
const draftHeaderColors = { ED: '#bfdbfe', EX: '#bbf7d0' };
const draftBorderColors = { ED: '#2563eb', EX: '#16a34a' };
const draftColorMap = { ED: '#eff6ff', EX: '#f0fdf4' };

function renderDraftGrid(cellState) {
  return render(
    <RubricDescriptorGrid
      rows={draftRows} levels={draftLevels} cellState={cellState} onSelect={() => {}}
      palette={{}} levelHeaderColors={draftHeaderColors} levelBorderColors={draftBorderColors}
      levelDraftColors={draftColorMap}
    />
  );
}

describe('RubricDescriptorGrid draft cell', () => {
  it('fills a draft cell with the level draftFill, not grey', () => {
    const { container } = renderDraftGrid((topicId, l) => (l === 'ED' ? { draft: true } : {}));
    // First body row, first level cell (ED).
    const cell = container.querySelectorAll('tbody td')[1];
    // jsdom normalises hex to rgb: #eff6ff → rgb(239, 246, 255).
    expect(cell.style.background).toContain('rgb(239, 246, 255)');
  });
});
// ─────────────────────────────────────────────────────────────────────────────

const rows = [{
  topic: { id: 't1', title: 'Select, analyze', category_title: 'HS Art: Produce', external_id: 'ART.5.1' },
  criterion: { id: 'c1', criterion_name: 'UI/UX', reporting_category: 'Produce',
    descriptors: { ED: 'Polished.', EX: 'Clear.', D: 'Inconsistent.', EM: 'Lacks.', IE: 'Insufficient Evidence' } },
}];
const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];
const palette = { produce: '#B4A7D6', create: '#9FC5E8' };
const headerColors = { ED:'#bfdbfe', EX:'#bbf7d0', D:'#fef08a', EM:'#fed7aa', IE:'#fecaca' };
const borderColors = { ED:'#2563eb', EX:'#16a34a', D:'#ca8a04', EM:'#ea580c', IE:'#dc2626' };

function renderGrid(cellState = () => ({}), onSelect = vi.fn()) {
  render(<RubricDescriptorGrid rows={rows} levels={LEVELS} cellState={cellState}
    onSelect={onSelect} palette={palette} levelHeaderColors={headerColors} levelBorderColors={borderColors} />);
  return onSelect;
}

describe('RubricDescriptorGrid', () => {
  it('renders full-word level headers (no abbreviations)', () => {
    renderGrid();
    expect(screen.getByText('Exhibiting Depth')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Insufficient Evidence' })).toBeInTheDocument();
    expect(screen.queryByText('ED')).not.toBeInTheDocument();
  });
  it('shows descriptor prose in each level cell', () => {
    renderGrid();
    expect(screen.getByText('Polished.')).toBeInTheDocument();
    expect(screen.getByText('Clear.')).toBeInTheDocument();
    expect(screen.getAllByText('Insufficient Evidence')).toHaveLength(2); // column header + IE cell
  });
  it('colours the topic column by reporting category', () => {
    renderGrid();
    const topicCell = screen.getByText('UI/UX').closest('td');
    expect(topicCell).toHaveStyle({ background: '#B4A7D6' });
  });
  it('renders the fuchsia sparkle on a suggested cell and fires onSelect on click', () => {
    const onSelect = renderGrid((tid, lvl) => (lvl === 'ED' ? { suggested: true } : {}));
    const edCell = screen.getByText('Polished.').closest('td');
    expect(edCell.querySelector('svg')).toBeTruthy();
    fireEvent.click(screen.getByText('Clear.').closest('td'));
    expect(onSelect).toHaveBeenCalledWith('t1', 'EX');
  });
  it('renders "Insufficient Evidence" in an uncovered topic\'s IE cell', () => {
    const uncovered = [{ topic: { id: 't9', title: 'Orphan topic', category_title: 'Produce', external_id: 'X9' }, criterion: null }];
    render(<RubricDescriptorGrid rows={uncovered} levels={LEVELS} cellState={() => ({})}
      onSelect={() => {}} palette={palette} levelHeaderColors={headerColors} levelBorderColors={borderColors} />);
    // header IE + the uncovered row's IE cell both read "Insufficient Evidence"
    expect(screen.getAllByText('Insufficient Evidence')).toHaveLength(2);
  });
});
