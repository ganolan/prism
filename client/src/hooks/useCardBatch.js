// The "Publish all" batch for a list of grade cards (#51), shared by the assessment page's Grading
// tab and the Attempts tab (#200), each with its own instance. pendingByUid maps each card's uid →
// 'publish' while it has changes to publish, or 'held' while its only changes are levels a final flag
// holds back (#177); displayByUid holds each card's Display (null: no comment, #184); cardsRef holds
// each card's handlers ({ getEntry, applyResult, holdsLevels, setDisplay, discard, ... }).
// `students` are the cards' rows (for held names); `onSaved(uid, patch)` patches a saved card's row.
import { useCallback, useRef, useState } from 'react';
import { sendAllGrades } from '../services/api.js';
import { flagClearedPatch, resubmissionFieldsPatch } from '../lib/cardPatches.js';
import { studentFullName } from '../lib/studentNames.js';
import { FLAGS } from '../lib/flags.js';

export function useCardBatch({ courseId, students, onSaved }) {
  const [pendingByUid, setPendingByUid] = useState({});
  const [displayByUid, setDisplayByUid] = useState({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const cardsRef = useRef({});

  // Stable registry callbacks (empty deps) so the cards' effects don't churn. The no-op guard keeps
  // a card reporting an unchanged pending state from triggering a re-render loop.
  const onPendingChange = useCallback((uid, state) => {
    setPendingByUid(prev => {
      if ((prev[uid] || false) === state) return prev;
      const next = { ...prev };
      if (state) next[uid] = state; else delete next[uid];
      return next;
    });
  }, []);
  const onDisplayChange = useCallback((uid, vis) => {
    setDisplayByUid(prev => (prev[uid] === vis ? prev : { ...prev, [uid]: vis }));
  }, []);
  const registerCard = useCallback((uid, handlers) => { cardsRef.current[uid] = handlers; }, []);
  const unregisterCard = useCallback((uid) => {
    delete cardsRef.current[uid];
    setPendingByUid(prev => {
      if (!prev[uid]) return prev;
      const next = { ...prev }; delete next[uid]; return next;
    });
    setDisplayByUid(prev => {
      if (!(uid in prev)) return prev;
      const next = { ...prev }; delete next[uid]; return next;
    });
  }, []);

  // Collect each pending, shown card's request entry and its in-place patch, then send the whole set
  // in one batched request (#51). A card on a final flag (Exempt, Missing) sends only its comment and
  // Display: its staged levels stay as its draft (#177), and the result names the student. The server
  // refuses a grade over a final flag (FLAGGED) as the backstop.
  async function publishAll(isShown) {
    const uids = Object.keys(pendingByUid).filter(isShown);
    if (uids.length === 0) return;
    setBulkSaving(true);
    setBulkResult(null);
    const items = [];
    const held = [];
    const byUid = new Map((students || []).map((st) => [st.schoology_uid, st]));
    for (const uid of uids) {
      const card = cardsRef.current[uid];
      const st = byUid.get(uid);
      if (st && card?.holdsLevels?.()) held.push(`${studentFullName(st)} (${FLAGS[Number(st.exception)]?.name || 'flagged'})`);
      const built = card?.getEntry();
      if (built) items.push({ uid, ...built });
    }
    const heldText = held.length ? ` Levels kept as a draft until the flag is cleared: ${held.join(', ')}.` : '';
    if (items.length === 0) {
      setBulkSaving(false);
      setBulkResult(`Nothing published.${heldText}`);
      return;
    }
    try {
      const { results } = await sendAllGrades(courseId, items.map(i => i.entry));
      const resultByUid = new Map((results || []).map(r => [r.uid, r]));
      let ok = 0, fail = 0;
      for (const i of items) {
        const r = resultByUid.get(i.uid);
        const success = r?.ok ?? false;
        cardsRef.current[i.uid]?.applyResult(success, r);
        // Each saved pair's post-save resubmission state comes back with its result (I2), and a
        // grade that cleared a marker its flagCleared (#40), and points the score Schoology holds (#181).
        if (success) {
          onSaved(i.uid, { ...i.patch, ...(r.score !== undefined ? { score: r.score } : {}), ...resubmissionFieldsPatch(r.resubmissionFields), ...flagClearedPatch(r.flagCleared) });
          ok++;
        } else { fail++; }
        // Published, but its feedback rows did not save in Prism: the grade and comment are in
        // Schoology (the server retired any saved copy), so the card shows them; the rows stay staged.
        if (!success && r?.published) {
          const { row_levels: _rows, ...published } = i.patch;
          onSaved(i.uid, { ...published, ...resubmissionFieldsPatch(r.resubmissionFields), ...flagClearedPatch(r.flagCleared) });
        }
      }
      setBulkResult(`Published ${ok} grade${ok !== 1 ? 's' : ''}${fail ? `, ${fail} failed` : ''}.${heldText}`);
    } catch (err) {
      // All-or-nothing: a non-2xx (incl. the 502 abort) rejects here: mark every card failed and
      // leave them pending so a retry is one click away.
      for (const i of items) cardsRef.current[i.uid]?.applyResult(false);
      setBulkResult(`Error: ${err.message}`);
    } finally {
      setBulkSaving(false);
    }
  }

  return {
    pendingByUid, displayByUid, cardsRef, bulkSaving, bulkResult, setBulkResult,
    onPendingChange, onDisplayChange, registerCard, unregisterCard, publishAll,
  };
}
