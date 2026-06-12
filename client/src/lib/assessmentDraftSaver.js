// A per-card draft saver: debounces typing into one trailing POST, flushes a
// discrete pick immediately, and flushes any pending save on page-hide/unmount
// via a keepalive transport. The React UI never awaits these — state is the
// instant source of truth; this only mirrors it to the DB. See
// docs/superpowers/specs/2026-06-12-assessment-drafts-db-migration-design.md.
import { saveAssessmentDraft, deleteAssessmentDraft, draftBeaconBody, DRAFTS_PATH } from '../services/api.js';

export function makeDraftSaver(target, { delay = 500 } = {}) {
  // target: { assignmentId, studentId, enrollmentId } (camelCase JS).
  let timer = null;
  let pendingDraft = null;   // latest draft object to POST, or null
  let pendingDelete = false; // latest intent is a delete

  // Map the camelCase target to the route's snake_case wire contract.
  function wireBody(draft) {
    return {
      assignment_id: target.assignmentId,
      student_id: target.studentId,
      enrollment_id: target.enrollmentId,
      draft,
    };
  }

  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

  function send() {
    clearTimer();
    if (pendingDraft) {
      const body = wireBody(pendingDraft);
      pendingDraft = null;
      saveAssessmentDraft(body).catch(() => {});
    } else if (pendingDelete) {
      pendingDelete = false;
      deleteAssessmentDraft(target).catch(() => {});
    }
  }

  return {
    // Persist a draft. immediate: skip the debounce (proficiency / display click).
    save(draft, { immediate = false } = {}) {
      pendingDraft = draft;
      pendingDelete = false;
      clearTimer();
      if (immediate) send();
      else timer = setTimeout(send, delay);
    },
    // Schedule removal of the server row (card returned to no-pending-changes).
    remove({ immediate = false } = {}) {
      pendingDraft = null;
      pendingDelete = true;
      clearTimer();
      if (immediate) send();
      else timer = setTimeout(send, delay);
    },
    // Best-effort flush of a pending SAVE on unload/unmount. A no-pending-changes
    // card has nothing to lose, so queued deletes are not flushed.
    flush({ beacon = false } = {}) {
      clearTimer();
      if (!pendingDraft) return;
      const body = wireBody(pendingDraft);
      pendingDraft = null;
      if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(DRAFTS_PATH, draftBeaconBody(body));
      } else {
        saveAssessmentDraft(body, { keepalive: true }).catch(() => {});
      }
    },
    dispose() { clearTimer(); pendingDraft = null; pendingDelete = false; },
  };
}
