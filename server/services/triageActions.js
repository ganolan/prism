// Shared "action with an optional Schoology status line" orchestration
// (triage resubmissions spec, Amendment B -> "Status lines"). Used by both the
// HTTP triage routes (server/routes/triage.js) and PrisMCP (mcp/handlers.js)
// so the sequence -- and its failure semantics -- live in exactly one place:
// lock the pair -> validate the Prism action -> publish (optional) -> record
// in Prism -> unlock.
import { lockPair } from './statusLinePublisher.js';

// A status line to publish with the action: omitted / '' -> Prism-only (as before).
export const hasLine = (commentLine) => commentLine != null && commentLine !== '';

// The pair a record belongs to (for the per-pair lock), or null when it doesn't exist.
export const pairOf = (db, table, id) => {
  const r = db.prepare(`SELECT student_id, assignment_id FROM ${table} WHERE id = ?`).get(Number(id));
  return r ? [r.student_id, r.assignment_id] : null;
};

// Runs { pair?, validate, publish?, record } in sequence. A second action on
// the same pair meanwhile gets BUSY (TriageError, via lockPair) before
// anything is read. A failed validate or publish changes nothing. If the
// record step fails AFTER a successful publish, the Schoology comment has
// already changed: the thrown error says so plainly (code
// RECORD_FAILED_AFTER_PUBLISH, with `comment`) so the caller can tell the
// teacher, and it is logged.
export async function act(db, { pair = null, validate, publish = null, record }) {
  let release = null;
  try {
    const p = pair ? pair() : null;
    if (p) release = lockPair(p[0], p[1]);
    const ctx = validate();
    const published = publish ? await publish(ctx) : null;
    try {
      // The record and its line's source land together (setStatusLineSource runs inside record).
      const result = db.transaction(() => record(ctx, published))();
      return published ? { ...result, statusLine: published } : result;
    } catch (err) {
      const removal = Boolean(published && 'removed' in published);
      // A no-op removal (no stored line / hand-edited) wrote nothing to Schoology.
      if (!published || published.removed === false) throw err;
      const what = removal ? 'The status line WAS removed from' : 'The comment WAS published to';
      console.error(`[triage] ${what} Schoology, but recording the action in Prism failed:`, err);
      const wrapped = new Error(
        `${what} the student's Schoology comment, but Prism could not record the action (${err.message}). Check the comment in Schoology, then reload and retry the action.`
      );
      wrapped.code = 'RECORD_FAILED_AFTER_PUBLISH';
      wrapped.published = true;
      wrapped.comment = published.comment ?? null;
      throw wrapped;
    }
  } finally {
    release?.();
  }
}
