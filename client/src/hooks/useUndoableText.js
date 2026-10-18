// Undo / redo for a text box whose value the app sometimes writes itself (#75).
//
// A controlled <textarea> loses the browser's own undo as soon as the app sets
// its value (a cleaned paste, an inserted line, a copied suggestion): the native
// stack no longer matches the text. This hook keeps its own history instead.
//
//   const text = useUndoableText(initial);
//   text.value                     the current text
//   text.set(next)                 a typing change (grouped, see below)
//   text.set(next, { step: true }) a change that is one undo step by itself
//   text.reset(value)              set the text and forget the history
//   text.clearHistory()            forget the history, keep the text
//   text.undo() / text.redo()      step back / forward; false when nothing to do
//   onKeyDown={text.onKeyDown}     Cmd/Ctrl+Z undo; Shift+Cmd/Ctrl+Z, Ctrl+Y redo
//
// Typing is grouped: consecutive typing changes share one step until there is a
// pause of GROUP_MS or more, or typing switches between adding and deleting
// text. Any discrete step, undo or redo also ends the current typing step.
import { useCallback, useRef, useState } from 'react';

export const GROUP_MS = 1000;
const MAX_STEPS = 200;

export function useUndoableText(initial) {
  const [value, setValue] = useState(initial);
  // Refs, not state: the stacks never render anything, and the handlers must
  // see the latest value between renders (two changes in one tick).
  const valueRef = useRef(value);
  const pastRef = useRef([]);
  const futureRef = useRef([]);
  // The open typing step: { at, kind: 'add' | 'delete' }, or null.
  const typingRef = useRef(null);

  const write = useCallback((next) => {
    valueRef.current = next;
    setValue(next);
  }, []);

  const set = useCallback((next, { step = false } = {}) => {
    const current = valueRef.current;
    if (next === current) return;
    const now = Date.now();
    const kind = next.length >= current.length ? 'add' : 'delete';
    const open = typingRef.current;
    const extendsTyping = !step && open && open.kind === kind && now - open.at < GROUP_MS;
    if (!extendsTyping) {
      pastRef.current.push(current);
      if (pastRef.current.length > MAX_STEPS) pastRef.current.shift();
    }
    futureRef.current = [];
    typingRef.current = step ? null : { at: now, kind };
    write(next);
  }, [write]);

  const move = useCallback((from, to) => {
    if (from.current.length === 0) return null;
    const previous = valueRef.current;
    to.current.push(previous);
    typingRef.current = null;
    const next = from.current.pop();
    write(next);
    return { previous, next };
  }, [write]);

  const undo = useCallback(() => move(pastRef, futureRef), [move]);
  const redo = useCallback(() => move(futureRef, pastRef), [move]);

  const clearHistory = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    typingRef.current = null;
  }, []);

  const reset = useCallback((next) => {
    clearHistory();
    write(next);
  }, [clearHistory, write]);

  const onKeyDown = useCallback((e) => {
    if (e.altKey || !(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    let moved;
    if (key === 'z') moved = e.shiftKey ? redo() : undo();
    else if (key === 'y' && e.ctrlKey && !e.shiftKey) moved = redo();
    else return;
    // Always stop the browser's own undo: its stack is out of step with ours.
    e.preventDefault();
    if (moved) placeCaret(e.currentTarget, moved.previous, moved.next);
  }, [undo, redo]);

  return { value, set, reset, clearHistory, undo, redo, onKeyDown };
}

// Put the caret at the end of the text that changed, once React has written
// the new value, so the teacher sees where the undo landed.
function placeCaret(el, before, after) {
  if (!el || typeof el.setSelectionRange !== 'function') return;
  let suffix = 0;
  const max = Math.min(before.length, after.length);
  while (suffix < max && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const pos = after.length - suffix;
  requestAnimationFrame(() => {
    try { el.setSelectionRange(pos, pos); } catch { /* detached */ }
  });
}
