// Edit and Done for grade cards shown read-only (#176): the student page's tasks and the gradebook
// pop-up. Takes what useGradeCards returns (`cards`, `refetchOne`) and `onChange`, the page's own
// reload after a card leaves edit mode or writes a flag.
//
//  - `card(aid)`: the card to draw, with what a write on it changed (`saved`) laid over it until
//    the task's own read brings a newer card.
//  - `startEdit(aid)`: the task's card is read again first. The card builds its edit state from its
//    props when it switches mode, so a draft saved elsewhere since the page loaded must be in them.
//    If the read fails, `editError(aid)` says so and the card stays read-only.
//  - `finishEdit(aid)` (the card's Done, after its draft save settles): back to read-only, then
//    `onChange`.
//  - `refreshTask(aid)` (the card's onRefreshPair, after a flag write): the task read again and
//    `onChange`, resolving to the fresh student. A failed read throws: the Flags pill says so.
//  - `saved(aid, patch)` (the card's onSaved, after a publish, Ask, Extend or Refer): the patch at
//    once, then the task read again. Without it a published card shows its old comment as unsaved
//    until the read lands, and its autosave could write a stray draft.
//  - `resubmitLessons`: the teacher's default lesson count for Ask to resubmit, read on the first Edit.
import { useState } from 'react';
import { getSettings } from '../services/api.js';

export function useCardEditing({ cards, refetchOne, onChange = null }) {
  const [patches, setPatches] = useState({}); // { [aid]: { over: card, patch } }
  const [editing, setEditing] = useState(() => new Set());
  const [errors, setErrors] = useState({}); // { [aid]: message } when Edit could not load the task
  const [resubmitLessons, setResubmitLessons] = useState(undefined);

  // The patch holds only over the card object it was made on, so any newer card replaces it.
  const card = (aid) => {
    const c = cards[aid];
    const p = patches[aid];
    return c && p && p.over === c ? { ...c, student: { ...c.student, ...p.patch } } : c;
  };

  async function startEdit(aid) {
    setErrors((e) => ({ ...e, [aid]: null }));
    if (resubmitLessons === undefined) {
      Promise.resolve().then(() => getSettings())
        .then((s) => setResubmitLessons(s?.triage?.resubmitLessonsDefault ?? 3))
        .catch(() => setResubmitLessons(3));
    }
    let fresh = null;
    try { fresh = await refetchOne(aid); } catch { fresh = null; }
    if (!fresh) {
      setErrors((e) => ({ ...e, [aid]: 'Could not load this task. Reload the page.' }));
      return;
    }
    setEditing((prev) => new Set(prev).add(aid));
  }

  function finishEdit(aid) {
    setEditing((prev) => { const next = new Set(prev); next.delete(aid); return next; });
    if (onChange) Promise.resolve().then(() => onChange()).catch(() => {});
  }

  async function refreshTask(aid) {
    const [fresh] = await Promise.all([refetchOne(aid), onChange ? onChange() : null]);
    return fresh?.student ?? null;
  }

  function saved(aid, patch) {
    if (patch) {
      setPatches((prev) => {
        const p = prev[aid];
        const base = p && p.over === cards[aid] ? p.patch : {};
        return { ...prev, [aid]: { over: cards[aid], patch: { ...base, ...patch } } };
      });
    }
    refetchOne(aid).catch(() => {});
  }

  return {
    card,
    isEditing: (aid) => editing.has(aid),
    editError: (aid) => errors[aid] || null,
    resubmitLessons: resubmitLessons ?? 3,
    startEdit,
    finishEdit,
    refreshTask,
    saved,
    // Leave edit mode everywhere without onChange (the student page's collapse: the card's unmount
    // sends its queued draft save).
    stopEditing: () => setEditing(new Set()),
  };
}
