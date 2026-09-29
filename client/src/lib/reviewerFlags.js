// Reviewer-notes helpers for the /assessment/ card.

const BRIEF_MAX = 140;

/**
 * The at-a-glance flag lines. Uses the agent-written brief
 * (`reviewer_flags_brief`) when there is one; otherwise the first sentence of
 * each paragraph of the full `reviewer_flags` text, trimmed. `hasMore` says
 * whether the full text holds anything the brief doesn't, i.e. whether a
 * "Show detailed flags" toggle is worth offering.
 */
export function briefFlags(full, brief) {
  const text = String(full ?? '').trim();
  if (Array.isArray(brief) && brief.length > 0) {
    return { items: brief, hasMore: text.length > 0 };
  }
  const paragraphs = text.split('\n').map(p => p.trim()).filter(Boolean);
  const items = paragraphs.map(firstSentence);
  const hasMore = paragraphs.some((p, i) => p !== items[i]);
  return { items, hasMore };
}

function firstSentence(paragraph) {
  const m = /^(.+?[.!?])(\s|$)/.exec(paragraph);
  const s = m ? m[1] : paragraph;
  return s.length > BRIEF_MAX ? `${s.slice(0, BRIEF_MAX).trimEnd()}…` : s;
}

/** Short fingerprint of a text, to tell a revised suggestion from the one already used. */
export function textSignature(text) {
  let h = 5381;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.length.toString(36)}-${h.toString(36)}`;
}
