// One student's grade cards for a course (#176): the assessment page's card for every task the
// student is on, from GET /api/students/:id/grade-cards. The student page and the gradebook pop-up
// share it. `assignmentId` (a Schoology assignment id) narrows every load to that one task's card:
// the gradebook pop-up shows one task, so it never loads the course's.
//
// The cards belong to the student, course (and task) they were fetched for: they read as {} the
// moment any changes (never the previous course's cards), and a superseded response is dropped.
// `reloadKey` refetches the same course without blanking the cards on screen. `enabled` false
// fetches nothing. `refetchOne(assignmentId)` re-reads one card (after a write, or before the card
// goes into edit mode), swaps it into `cards` and resolves to it.
import { useState, useEffect, useRef, useCallback } from 'react';
import { getGradeCards } from '../services/api.js';

const NONE = {};

export function useGradeCards({ studentId = null, courseId = null, assignmentId = null, enabled = true, reloadKey = 0 } = {}) {
  const live = enabled && studentId != null && courseId != null;
  const key = `${studentId ?? ''}|${courseId ?? ''}|${assignmentId ?? ''}`;
  const [loaded, setLoaded] = useState({ key: null, cards: NONE, course: null, error: null });
  const keyRef = useRef(key);
  keyRef.current = key;
  // Request order. Every full load and every refetchOne takes the next number when it is issued.
  // A response may only change what a newer request has not already settled:
  //  - a full load keeps any card a refetchOne issued after it started has already put in;
  //  - a refetchOne is dropped if a full load issued after it has already landed (that load is at
  //    least as fresh) or if a newer refetchOne for the same task has already landed. A full load
  //    issued after it but still in flight does not drop it: the card goes in now (Edit builds the
  //    editor from it), and the full load replaces it when it lands.
  const seq = useRef(0);
  const lastLandedFullSeq = useRef(0); // the newest full load whose answer has been put in
  const settled = useRef({}); // { [assignmentId]: { seq, card } } the newest refetchOne answer to land

  useEffect(() => {
    if (!live) return undefined;
    let active = true;
    const mine = ++seq.current;
    // Promise.resolve().then so a synchronous throw (or an automocked api) is a catch, not a crash.
    Promise.resolve()
      .then(() => getGradeCards(studentId, assignmentId != null ? { courseId, assignmentId } : { courseId }))
      .then((r) => {
        if (!active) return;
        lastLandedFullSeq.current = Math.max(lastLandedFullSeq.current, mine);
        const fresh = r?.cards || NONE;
        setLoaded(() => {
          const cards = { ...fresh };
          for (const [aid, one] of Object.entries(settled.current)) {
            if (one.seq > mine) cards[aid] = one.card;
          }
          return { key, cards, course: r?.course || null, error: null };
        });
      })
      .catch((e) => {
        if (!active) return;
        // A failed reload keeps what is already on screen for this course.
        setLoaded((prev) => ({ ...(prev.key === key ? prev : { cards: NONE, course: null }), key, error: e?.message || 'Could not load the grade cards' }));
      });
    return () => { active = false; };
  }, [live, key, studentId, courseId, assignmentId, reloadKey]);

  const refetchOne = useCallback(async (aid) => {
    const askedKey = key;
    const mine = ++seq.current;
    const r = await getGradeCards(studentId, { courseId, assignmentId: aid });
    const card = r?.cards?.[aid] ?? null;
    const stale = keyRef.current !== askedKey || lastLandedFullSeq.current > mine || (settled.current[aid]?.seq || 0) > mine;
    if (!stale) {
      if (card) settled.current[aid] = { seq: mine, card };
      setLoaded((prev) => (prev.key !== askedKey ? prev : {
        ...prev,
        error: null,
        course: r?.course || prev.course,
        cards: card ? { ...prev.cards, [aid]: card } : prev.cards,
      }));
    }
    return card;
  }, [key, studentId, courseId]);

  const current = live && loaded.key === key;
  return {
    cards: current ? loaded.cards : NONE,
    course: current ? loaded.course : null,
    loading: live && !current,
    error: current ? loaded.error : null,
    refetchOne,
  };
}
