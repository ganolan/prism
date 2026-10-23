// The comment_status Schoology keeps on a grade record: 1 (Display to student) only when the
// record has a comment. With an empty comment it stores null whatever was sent (#183, verified
// 23 Oct 2026: 8807 of 8807 synced empty comments held null, and a write of 1 read back null).
// Mirror client/src/lib/cardPatches.js shownCommentStatus.
export const storedCommentStatus = (comment, visible) => (String(comment ?? '') !== '' && visible ? 1 : null);
