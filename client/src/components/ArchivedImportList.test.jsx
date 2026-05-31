import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ArchivedImportList from './ArchivedImportList.jsx';

const SECTIONS = [
  { sectionId: 'a1', courseTitle: 'Robotics',         noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' }, // 2024-25 S1
  { sectionId: 'a2', courseTitle: 'Mobile App Dev',   noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2024 - 01/11/2025' }, // 2024-25 S1
  { sectionId: 'a3', courseTitle: 'Photography',      noCourseCode: true,  gradingPeriod: 'Semester 2: 01/06/2025 - 06/15/2025' }, // 2024-25 S2, no-code
  { sectionId: 'b1', courseTitle: 'Coding in Action', noCourseCode: false, gradingPeriod: 'Semester 1: 08/14/2023 - 01/11/2024' }, // 2023-24 S1
];

function renderList(props = {}) {
  return render(
    <ArchivedImportList
      sections={props.sections || SECTIONS}
      busy={props.busy ?? false}
      onImport={props.onImport || (() => {})}
    />
  );
}

describe('ArchivedImportList', () => {
  it('groups rows under year then semester, most recent year first', () => {
    renderList();
    const years = screen.getAllByText(/^20\d\d-\d\d$/).map((n) => n.textContent);
    expect(years).toEqual(['2024-25', '2023-24']);
    expect(screen.getAllByText('Semester 1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Robotics')).toBeInTheDocument();
  });

  it('counts the selection and imports it', () => {
    const onImport = vi.fn();
    renderList({ onImport });
    fireEvent.click(screen.getByLabelText('Robotics'));
    fireEvent.click(screen.getByLabelText('Coding in Action'));
    fireEvent.click(screen.getByRole('button', { name: /Import 2 selected/ }));
    expect(onImport.mock.calls[0][0].sort()).toEqual(['a1', 'b1']);
  });

  it('select-year selects only coded sections in that year (skips no-code)', () => {
    renderList();
    fireEvent.click(screen.getByLabelText('Select all 2024-25'));
    expect(screen.getByLabelText('Robotics').checked).toBe(true);
    expect(screen.getByLabelText('Mobile App Dev').checked).toBe(true);
    expect(screen.getByLabelText('Photography').checked).toBe(false); // no-code excluded from bulk
  });

  it('a no-code row is still individually tickable', () => {
    renderList();
    fireEvent.click(screen.getByLabelText('Photography'));
    expect(screen.getByLabelText('Photography').checked).toBe(true);
  });

  it('a no-code row individually ticked is included in Import N selected', () => {
    const onImport = vi.fn();
    renderList({ onImport });
    fireEvent.click(screen.getByLabelText('Photography'));
    fireEvent.click(screen.getByRole('button', { name: /Import 1 selected/ }));
    expect(onImport.mock.calls[0][0]).toContain('a3');
  });

  it('Import all imports the year\'s coded sections only', () => {
    const onImport = vi.fn();
    renderList({ onImport });
    fireEvent.click(screen.getByRole('button', { name: /Import all \(2\)/ })); // 2024-25 has a1,a2 coded
    expect(onImport.mock.calls[0][0].sort()).toEqual(['a1', 'a2']);
    expect(onImport.mock.calls[0][0]).not.toContain('a3');
  });

  it('Select all is indeterminate with a partial selection and toggles all coded', () => {
    renderList();
    fireEvent.click(screen.getByLabelText('Robotics'));
    expect(screen.getByLabelText('Select all').indeterminate).toBe(true);
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(screen.getByLabelText('Robotics').checked).toBe(true);
    expect(screen.getByLabelText('Coding in Action').checked).toBe(true);
  });

  it('disables every input and button when busy', () => {
    renderList({ busy: true });
    expect(screen.getByLabelText('Robotics')).toBeDisabled();
    expect(screen.getByLabelText('Select all')).toBeDisabled();
    screen.getAllByRole('button', { name: /Import all/ }).forEach((btn) => expect(btn).toBeDisabled());
  });

  it('prunes selection when sections shrink (imported drop out)', () => {
    const { rerender } = renderList();
    fireEvent.click(screen.getByLabelText('Robotics'));
    expect(screen.getByRole('button', { name: /Import 1 selected/ })).toBeInTheDocument();
    rerender(<ArchivedImportList sections={SECTIONS.filter((s) => s.sectionId !== 'a1')} busy={false} onImport={() => {}} />);
    expect(screen.getByRole('button', { name: /Import 0 selected/ })).toBeInTheDocument();
  });
});
