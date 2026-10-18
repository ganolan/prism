import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useUndoableText } from './useUndoableText.js';

// A stand-in for the comment box: a textarea that types through the hook, plus
// buttons for a discrete step and a history reset.
function Box({ initial = '' }) {
  const text = useUndoableText(initial);
  return (
    <div>
      <textarea
        aria-label="box"
        value={text.value}
        onChange={(e) => text.set(e.target.value)}
        onKeyDown={text.onKeyDown}
      />
      <button onClick={() => text.set(`${text.value}[step]`, { step: true })}>step</button>
      <button onClick={() => text.reset('')}>reset</button>
      <button onClick={() => text.clearHistory()}>clear</button>
    </div>
  );
}

const box = () => screen.getByLabelText('box');
// Simulate typing one character at a time as onChange sees it.
function typeChars(el, chars) {
  for (const c of chars) fireEvent.change(el, { target: { value: el.value + c } });
}
const undo = (el, extra = {}) => fireEvent.keyDown(el, { key: 'z', metaKey: true, ...extra });
const redo = (el) => fireEvent.keyDown(el, { key: 'z', metaKey: true, shiftKey: true });

afterEach(() => vi.restoreAllMocks());

describe('useUndoableText', () => {
  it('groups a burst of typing into one undo step, and redoes it', () => {
    render(<Box initial="Hi" />);
    typeChars(box(), ' there');
    expect(box()).toHaveValue('Hi there');
    undo(box());
    expect(box()).toHaveValue('Hi');
    redo(box());
    expect(box()).toHaveValue('Hi there');
  });

  it('ends a typing step after a pause of a second or more', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    render(<Box />);
    typeChars(box(), 'one');
    now += 1500;
    typeChars(box(), ' two');
    undo(box());
    expect(box()).toHaveValue('one');
    undo(box());
    expect(box()).toHaveValue('');
  });

  it('ends a typing step when typing switches to deleting', () => {
    render(<Box />);
    typeChars(box(), 'abc');
    fireEvent.change(box(), { target: { value: 'ab' } });
    undo(box());
    expect(box()).toHaveValue('abc');
    undo(box());
    expect(box()).toHaveValue('');
  });

  it('records a discrete step on its own, even straight after typing', () => {
    render(<Box />);
    typeChars(box(), 'ab');
    fireEvent.click(screen.getByText('step'));
    expect(box()).toHaveValue('ab[step]');
    undo(box());
    expect(box()).toHaveValue('ab');
    undo(box());
    expect(box()).toHaveValue('');
  });

  it('accepts Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y as well as Cmd', () => {
    render(<Box />);
    typeChars(box(), 'x');
    fireEvent.keyDown(box(), { key: 'z', ctrlKey: true });
    expect(box()).toHaveValue('');
    fireEvent.keyDown(box(), { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(box()).toHaveValue('x');
    fireEvent.keyDown(box(), { key: 'z', ctrlKey: true });
    fireEvent.keyDown(box(), { key: 'y', ctrlKey: true });
    expect(box()).toHaveValue('x');
  });

  it('stops the browser undo for the shortcut, and leaves other keys alone', () => {
    render(<Box />);
    const cancelled = !fireEvent.keyDown(box(), { key: 'z', metaKey: true });
    expect(cancelled).toBe(true); // preventDefault, even with nothing to undo
    expect(fireEvent.keyDown(box(), { key: 'a', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: 'z' })).toBe(true);
  });

  it('a new change after an undo drops the redo stack', () => {
    render(<Box />);
    typeChars(box(), 'a');
    undo(box());
    typeChars(box(), 'b');
    redo(box());
    expect(box()).toHaveValue('b');
  });

  it('reset sets the value and forgets the history; clearHistory keeps the value', () => {
    render(<Box />);
    typeChars(box(), 'abc');
    fireEvent.click(screen.getByText('reset'));
    undo(box());
    expect(box()).toHaveValue('');
    typeChars(box(), 'kept');
    fireEvent.click(screen.getByText('clear'));
    expect(box()).toHaveValue('kept');
    undo(box());
    expect(box()).toHaveValue('kept');
  });

  it('ignores a change to the same value (no empty step)', () => {
    render(<Box initial="same" />);
    act(() => { fireEvent.change(box(), { target: { value: 'same' } }); });
    fireEvent.click(screen.getByText('step'));
    undo(box());
    expect(box()).toHaveValue('same');
    undo(box());
    expect(box()).toHaveValue('same');
  });
});
