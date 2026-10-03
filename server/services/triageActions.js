// Shared "action with an optional Schoology status line" orchestration
// (triage resubmissions spec, Amendment B -> "Status lines"). Used by both the
// HTTP triage routes (server/routes/triage.js) and PrisMCP (mcp/handlers.js)
// so the sequence -- and its failure semantics -- live in exactly one place:
// lock the pair -> validate the Prism action -> publish (optional) -> unsubmit
// (optional, Phase 2: an Ask on LTI work) -> record in Prism -> unlock.
import { lockPair, publishStatusLine, setStatusLineSource } from './statusLinePublisher.js';
import { assertCanRequest, requestResubmission, setUnsubmitError } from './resubmissions.js';
import { assertCanUnsubmit, tryUnsubmitLti } from './ltiUnsubmit.js';

// A status line to publish with the action: omitted / '' -> Prism-only (as before).
export const hasLine = (commentLine) => commentLine != null && commentLine !== '';

// The pair a record belongs to (for the per-pair lock), or null when it doesn't exist.
export const pairOf = (db, table, id) => {
  const r = db.prepare(`SELECT student_id, assignment_id FROM ${table} WHERE id = ?`).get(Number(id));
  return r ? [r.student_id, r.assignment_id] : null;
};

// Runs { pair?, validate, publish?, unsubmit?, record } in sequence. A second action on
// the same pair meanwhile gets BUSY (TriageError, via lockPair) before
// anything is read. A failed validate or publish changes nothing. `unsubmit(ctx)`
// never throws: it resolves to { ok: true } or { ok: false, error, code, url }, which
// record(ctx, published, unsubmitted) can persist and the result carries as `unsubmit`
// -- a failed unsubmit still records the action. If the record step fails AFTER a
// successful publish or unsubmit, Schoology has already changed: the thrown error says
// so plainly (code RECORD_FAILED_AFTER_PUBLISH, with `comment`) so the caller can tell
// the teacher, and it is logged.
export async function act(db, { pair = null, validate, publish = null, unsubmit = null, record }) {
  let release = null;
  try {
    const p = pair ? pair() : null;
    if (p) release = lockPair(p[0], p[1]);
    const ctx = validate();
    const published = publish ? await publish(ctx) : null;
    const unsubmitted = unsubmit ? await unsubmit(ctx) : null;
    try {
      // The record and its line's source land together (setStatusLineSource runs inside record).
      const result = db.transaction(() => record(ctx, published, unsubmitted))();
      const out = published ? { ...result, statusLine: published } : result;
      return unsubmitted ? { ...out, unsubmit: unsubmitted } : out;
    } catch (err) {
      const removal = Boolean(published && 'removed' in published);
      // A no-op removal (no stored line / hand-edited) wrote nothing to Schoology.
      const wroteComment = Boolean(published) && published.removed !== false;
      const didUnsubmit = unsubmitted?.ok === true;
      if (!wroteComment && !didUnsubmit) throw err;
      const changed = [
        wroteComment && (removal ? 'The status line WAS removed from the student\'s Schoology comment' : 'The comment WAS published to the student\'s Schoology comment'),
        didUnsubmit && 'their work WAS unsubmitted in Schoology',
      ].filter(Boolean).join(', and ');
      const what = changed.charAt(0).toUpperCase() + changed.slice(1);
      console.error(`[triage] ${what}, but recording the action in Prism failed:`, err);
      const wrapped = new Error(
        `${what}, but Prism could not record the action (${err.message}). Check ${didUnsubmit ? 'the student' : 'the comment'} in Schoology, then reload and retry the action.`
      );
      wrapped.code = 'RECORD_FAILED_AFTER_PUBLISH';
      wrapped.published = true;
      wrapped.comment = published?.comment ?? null;
      if (didUnsubmit) wrapped.unsubmitted = true;
      throw wrapped;
    }
  } finally {
    release?.();
  }
}

// Ask to resubmit (POST /api/triage/resubmissions and PrisMCP request_resubmission):
// validate (eligible pair, no open request, and -- when `unsubmit` -- LTI work that is
// submitted) -> publish the ask line (if any) -> unsubmit the OneDrive work (if asked)
// -> record. A failed unsubmit still records the ask, with the failure on the request
// (unsubmit_error) and { unsubmit: { ok: false, error, url } } in the result.
// `unsubmitOpts` is for tests (an injected browser page).
export function askResubmission(db, {
  studentId, assignmentId, lessons = null, note = null, commentLine = null, unsubmit = false, source = 'app', unsubmitOpts,
}) {
  return act(db, {
    pair: () => [studentId, assignmentId],
    validate: () => {
      const ctx = assertCanRequest(db, { studentId, assignmentId, lessons });
      if (unsubmit) assertCanUnsubmit(db, { studentId: ctx.student.id, assignmentId: ctx.assignment.id });
      return ctx;
    },
    publish: hasLine(commentLine) ? ((ctx) => publishStatusLine(db, {
      studentId: ctx.student.id, assignmentId: ctx.assignment.id, line: commentLine, kind: 'ask',
    })) : null,
    unsubmit: unsubmit ? ((ctx) => tryUnsubmitLti(db, { studentId: ctx.student.id, assignmentId: ctx.assignment.id }, unsubmitOpts)) : null,
    record: (ctx, published, unsubmitted) => {
      let r = requestResubmission(db, { studentId, assignmentId, lessons, note, source });
      if (published) setStatusLineSource(db, { studentId: ctx.student.id, assignmentId: ctx.assignment.id, type: 'resubmission', id: r.id });
      if (unsubmitted && !unsubmitted.ok) r = setUnsubmitError(db, r.id, unsubmitted.error);
      return r;
    },
  });
}
