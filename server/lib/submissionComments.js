// Submission comment threads (a student's dropbox comments on Schoology).
// Schoology starts each student comment with an automatic "Revision N submitted"
// line every time they submit; anything the student typed in the comment box
// follows in the same comment. Students often answer a task's written questions
// there, so grading must read it. See .claude/schoology-api-reference.md,
// "Submission comment threads".

const AUTO_LINE = /^\s*Revision \d+ submitted\s*$/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

// Plain text of a comment: tags removed, entities decoded, line ends made ordinary.
export function commentPlainText(raw) {
  return String(raw ?? '')
    .replace(/<br\s*\/?>|<\/p\s*>|<\/div\s*>|<\/li\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()] != null) return ENTITIES[e.toLowerCase()];
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e[0] === '#') return String.fromCodePoint(Number(e.slice(1)));
      return m;
    })
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.trimEnd()).join('\n')
    .trim();
}

// { automatic: ["Revision N submitted", ...], text: everything else }
export function splitAutomatic(text) {
  const automatic = []; const rest = [];
  for (const line of String(text).split('\n')) (AUTO_LINE.test(line) ? automatic : rest).push(line);
  return { automatic: automatic.map((l) => l.trim()), text: rest.join('\n').trim() };
}

export function authorRole(authorUid, { studentUid, teacherUids }) {
  const uid = String(authorUid);
  if (uid === String(studentUid)) return 'student';
  return teacherUids?.has(uid) ? 'teacher' : 'other';
}

// The files of a stored row (JSON), without the signed download path.
export function commentFiles(row) {
  let files = [];
  try { files = JSON.parse(row.attachments || '[]') || []; } catch { files = []; }
  return files.map((f) => ({
    fid: f.fid != null ? String(f.fid) : null, filename: f.filename, title: f.title ?? f.filename,
    filesize: f.filesize ?? 0, filemime: f.filemime ?? null, extension: f.extension ?? null,
  }));
}

// A stored submission_comments row → the shape the UI and PrisMCP read.
// A student comment is automatic only when it holds nothing but Schoology's
// Revision lines: typed text or an attached file makes it the student's own.
export function describeComment(row) {
  const text = commentPlainText(row.body);
  const isStudent = row.author_role === 'student';
  const attachments = commentFiles(row);
  const { automatic, text: typed } = isStudent ? splitAutomatic(text) : { automatic: [], text };
  return {
    id: String(row.schoology_comment_id),
    author_uid: String(row.author_uid),
    author_role: row.author_role,
    author_name: row.author_name ?? null,
    is_mine: !!row.is_mine,
    created: row.created ? new Date(Number(row.created) * 1000).toISOString() : null,
    text,
    automatic_lines: automatic,
    is_automatic: isStudent && automatic.length > 0 && !typed && !attachments.length,
    student_text: isStudent && typed ? typed : null,
    attachments,
  };
}

export function threadSummary(comments) {
  const written = comments.filter((c) => c.student_text);
  return {
    count: comments.length,
    student_text: written.length > 0,
    student_words: written.reduce((n, c) => n + c.student_text.split(/\s+/).filter(Boolean).length, 0),
    // Files the student attached in a comment (evidence, like typed text), and all files.
    student_files: comments.filter((c) => c.author_role === 'student').reduce((n, c) => n + (c.attachments?.length || 0), 0),
    files: comments.reduce((n, c) => n + (c.attachments?.length || 0), 0),
  };
}
