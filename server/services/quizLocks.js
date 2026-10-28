// One lock per quiz group, shared by the loader, the writer and mark_frq_writeback (spec §14): a load
// rewrites the stored Schoology copy the writer checks against, so neither runs while the other does,
// and an agent cannot record a write-back in the middle of either. In memory: PrisMCP runs inside the
// server since #131, so this one lock covers the pages and the agent tools.
import { QuizError } from './quizError.js';

const held = new Map(); // group id -> 'loading' | 'posting'

const BUSY = {
  loading: 'This quiz is loading from Schoology: try again when it finishes',
  posting: 'Marks for this quiz are being posted to Schoology: try again when it finishes',
};

export const groupBusy = (groupId) => held.get(Number(groupId)) ?? null;

// Throws BUSY while the group is held; else holds it. -> release()
export function holdGroup(groupId, kind) {
  const id = Number(groupId);
  if (held.has(id)) throw new QuizError('BUSY', BUSY[held.get(id)]);
  held.set(id, kind);
  return () => { if (held.get(id) === kind) held.delete(id); };
}

export function assertGroupFree(groupId) {
  const kind = groupBusy(groupId);
  if (kind) throw new QuizError('BUSY', BUSY[kind]);
}
