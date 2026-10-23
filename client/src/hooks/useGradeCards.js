// One student's grade cards for a course (#176): the assessment page's card for every task the
// student is on, from GET /api/students/:id/grade-cards. The student page and the gradebook pop-up
// share it.
//
// The cards belong to the student and course they were fetched for: they read as {} the moment
// either changes (never the previous course's cards), and a superseded response is dropped.
// `reloadKey` refetches the same course without blanking the cards on screen. `enabled` false
// fetches nothing. `refetchOne(assignmentId)` re-reads one card (after a write, or before the card
// goes into edit mode), swaps it into `cards` and resolves to it.
import { useState, useEffect, useRef, useCallback } from 'react';
import { getGradeCards } from '../services/api.js';

const NONE = {};

export function useGradeCards({ studentId = null, courseId = null, enabled = true, reloadKey = 0 } = {}) {
  const live = enabled && studentId != null && courseId != null;
  const key = `${studentId ?? ''}|${courseId ?? ''}`;
  const [loaded, setLoaded] = useState({ key: null, cards: NONE, course: null, error: null });
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!live) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => getGradeCards(studentId, { courseId }))
      .then((r) => {
        if (!active) return;
        setLoaded({ key, cards: r?.cards || NONE, course: r?.course || null, error: null });
      })
      .catch((e) => {
        if (!active) return;
        // A failed reload keeps what is already on screen for this course.
        setLoaded((prev) => ({ ...(prev.key === key ? prev : { cards: NONE, course: null }), key, error: e?.message || 'Could not load the grade cards' }));
      });
    return () => { active = false; };
  }, [live, key, studentId, courseId, reloadKey]);

  const refetchOne = useCallback(async (assignmentId) => {
    const askedKey = key;
    const r = await getGradeCards(studentId, { courseId, assignmentId });
    const card = r?.cards?.[assignmentId] ?? null;
    if (keyRef.current === askedKey) {
      setLoaded((prev) => (prev.key !== askedKey ? prev : {
        ...prev,
        course: r?.course || prev.course,
        cards: card ? { ...prev.cards, [assignmentId]: card } : prev.cards,
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
