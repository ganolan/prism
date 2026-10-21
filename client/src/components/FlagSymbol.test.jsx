import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FlagSymbol from './FlagSymbol.jsx';

const KEYS = { 1: ['exempt', 'Exempt'], 2: ['incomplete', 'Incomplete'], 3: ['missing', 'Missing'], 5: ['absent', 'Absent'], 6: ['late', 'Late'] };

describe('FlagSymbol', () => {
  it.each(Object.entries(KEYS))('code %s draws flag-symbol--%s with an aria-label of its name and an svg glyph', (code, [key, name]) => {
    render(<FlagSymbol code={Number(code)} />);
    const sym = screen.getByRole('img', { name });
    expect(sym).toHaveClass('flag-symbol', `flag-symbol--${key}`);
    expect(sym.querySelector('.flag-symbol__disc svg')).not.toBeNull();
  });

  it('draws nothing for a code that is not a flag (4 is invalid)', () => {
    const { container } = render(<FlagSymbol code={4} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('showName puts the name in capitals under the disc; without it there is no name text', () => {
    const { rerender } = render(<FlagSymbol code={5} showName />);
    expect(document.querySelector('.flag-symbol__name')).toHaveTextContent(/^ABSENT$/);
    rerender(<FlagSymbol code={5} />);
    expect(document.querySelector('.flag-symbol__name')).toBeNull();
  });

  it('size cell is the default and inline is a class', () => {
    const { rerender } = render(<FlagSymbol code={1} />);
    expect(screen.getByRole('img', { name: 'Exempt' })).toHaveClass('flag-symbol--cell');
    rerender(<FlagSymbol code={1} size="inline" />);
    expect(screen.getByRole('img', { name: 'Exempt' })).toHaveClass('flag-symbol--inline');
  });

  it('the popover opens on hover and on focus, and shows the name and the guide line', () => {
    render(<FlagSymbol code={6} firstName="Sam" />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    const sym = screen.getByRole('img', { name: 'Late' });
    fireEvent.mouseEnter(sym);
    const pop = screen.getByRole('tooltip');
    expect(pop).toHaveTextContent('Late');
    expect(pop).toHaveTextContent("Left out of Sam's grade while flagged.");
    expect(pop).not.toHaveTextContent('Visibly flags');
    fireEvent.mouseLeave(sym);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(sym);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('Missing\'s guide line says the topic levels still count only on an aligned task (#40)', () => {
    const { rerender } = render(<FlagSymbol code={3} aligned />);
    fireEvent.mouseEnter(screen.getByRole('img', { name: 'Missing' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Scores this task as zero. Topic levels already entered still count.');
    rerender(<FlagSymbol code={3} />);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^MissingScores this task as zero\.$/);
  });

  it('the popover shows the symbol beside the name (not a second named image)', () => {
    render(<FlagSymbol code={5} />);
    fireEvent.click(screen.getByRole('img', { name: 'Absent' }));
    const pop = screen.getByRole('tooltip');
    expect(pop.querySelector('.flag-symbol__disc svg')).not.toBeNull();
    expect(pop.querySelector('.flag-symbol--absent')).not.toBeNull();
    expect(screen.getAllByRole('img', { name: 'Absent' })).toHaveLength(1);
  });

  it('a tap (click) opens it and stays open until the next tap', () => {
    render(<FlagSymbol code={1} firstName="Sam" />);
    const sym = screen.getByRole('img', { name: 'Exempt' });
    fireEvent.click(sym);
    expect(screen.getByRole('tooltip')).toHaveTextContent("Left out of Sam's grade.");
    fireEvent.mouseLeave(sym);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.click(sym);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('Escape closes it', () => {
    render(<FlagSymbol code={2} />);
    const sym = screen.getByRole('img', { name: 'Incomplete' });
    fireEvent.click(sym);
    fireEvent.keyDown(sym, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('the popover adds the reason line and the saved grade note', () => {
    render(<FlagSymbol code={1} firstName="Sam" reasonLine="Marked exempt on Tue 21/10. Medical leave." savedLevel="Exhibiting (3.5)" />);
    fireEvent.click(screen.getByRole('img', { name: 'Exempt' }));
    const pop = screen.getByRole('tooltip');
    expect(pop).toHaveTextContent('Marked exempt on Tue 21/10. Medical leave.');
    expect(pop).toHaveTextContent('Grade saved in Prism: Exhibiting (3.5). Clear the flag to restore it.');
  });

  it('without a reason or a saved grade, neither line shows', () => {
    render(<FlagSymbol code={3} />);
    fireEvent.click(screen.getByRole('img', { name: 'Missing' }));
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Grade saved in Prism');
  });

  it('passive: hover shows it, but a click is left to the surrounding control and the symbol is not focusable', () => {
    render(<FlagSymbol code={5} passive />);
    const sym = screen.getByRole('img', { name: 'Absent' });
    expect(sym).not.toHaveAttribute('tabindex');
    fireEvent.mouseEnter(sym);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(sym);
    fireEvent.click(sym);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('has no em dash in its copy', () => {
    for (const code of [1, 2, 3, 5, 6]) {
      const { unmount } = render(<FlagSymbol code={code} firstName="Sam" savedLevel="X" reasonLine="r" showName />);
      fireEvent.click(screen.getByRole('img'));
      expect(document.body.textContent).not.toMatch(/—/);
      unmount();
    }
  });
});
