// A profile page for anyone People search finds (#203, Graham 28 Oct 2026): students Graham does not teach now,
// students in after-school programmes, staff and parents. A person Prism holds as a student goes to their student
// page instead. Read from Schoology on first open, stored in `people`, read again when opened more than 7 days later
// (or on Read again), and kept until the teacher deletes it (Graham, 28 Oct 2026: one table, never deleted). A
// profiled student who later joins one of his classes moves to the student record: their notes go with them.
//
// What Schoology answers for another user (probed 28/10/2026, .claude/schoology-api-reference.md "1a. Another
// user's profile"): REST /users/{uid} has names, email, photo and parents but no role_id or position; the web Info
// page (/user/{uid}/info, plain HTTP on the saved session) has a student's Parents and Advisors rows, and a staff
// member's Position, Subjects taught and Phone when filled in. /users/{uid}/sections and /groups answer too.
// No PowerSchool read: PowerTeacher reaches only the teacher's own classes.
export const REREAD_AFTER_DAYS = 7;
const DAY = 86400000;

const decode = (v) => v.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (html) => decode(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// The Info page's rows → Map label → value text (<tr><th>label</th><td>value</td></tr>).
export function infoRows(html) {
  const rows = new Map();
  for (const [, row] of String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const th = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(row);
    const td = /<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(row);
    if (!th) continue;
    const label = text(th[1]);
    if (label && !rows.has(label)) rows.set(label, td ? text(td[1]) : '');
  }
  return rows;
}

// Every uid in Schoology's child_uids, whatever its form: a parent's is a string (2 of 2 parents, 28/10/2026), a
// student's an empty object; an array or an object of them is read the same way.
export function childUids(v) {
  const out = new Set();
  const walk = (x) => {
    if (x == null) return;
    if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === 'object') Object.values(x).forEach(walk);
    else for (const m of String(x).match(/\d+/g) || []) out.add(m);
  };
  walk(v);
  return [...out];
}

// Who this is, from what Schoology shows: a student's Info page has Parents or Advisors rows and a student number
// as their school email (digits@hkis.edu.hk); staff have Position or Subjects taught, or a named @hkis.edu.hk
// address; a parent has a Children row or child_uids (2 of 2, 28/10/2026). → 'student' | 'staff' | 'parent' | null.
export function classifyPerson(rest, rows) {
  const email = String(rest?.primary_email || '').toLowerCase();
  if (rows.has('Parents') || rows.has('Advisors') || /^\d+@hkis\.edu\.hk$/.test(email)) return 'student';
  if (rows.has('Position') || rows.has('Subjects taught') || /^[^@\d][^@]*@hkis\.edu\.hk$/.test(email)) return 'staff';
  if (rows.has('Children') || childUids(rest?.child_uids).length) return 'parent';
  return null;
}

/**
 * Read one person from Schoology. `readers`: { getProfile(uid), getProfiles(uids) → Map, getSections(uid),
 * getGroups(uid), readInfoPage(uid) → html }. → the stored shape (names, email, photo, kind, details).
 */
export async function readPerson(uid, readers) {
  const rest = await readers.getProfile(uid);
  const rows = infoRows(await readers.readInfoPage(uid));
  const kind = classifyPerson(rest, rows);
  const details = {};
  const keep = (key, label) => { const v = rows.get(label); if (v) details[key] = v; };
  keep('position', 'Position');
  keep('subjects', 'Subjects taught');
  keep('phone', 'Phone');
  const parents = rest.parents?.parent ? [].concat(rest.parents.parent) : [];
  if (parents.length) {
    details.parents = parents.map((p) => ({ uid: String(p.id ?? p.uid ?? ''), name: [p.name_first, p.name_last].filter(Boolean).join(' '), email: p.primary_email || null }));
  }
  const kids = childUids(rest.child_uids);
  if (kids.length) {
    const found = await readers.getProfiles(kids);
    details.children = kids.map((k) => { const c = found.get(k); return { uid: k, name: c ? (c.name_display || [c.name_first, c.name_last].filter(Boolean).join(' ')) : null }; });
  }
  if (kind === 'student') {
    details.courses = (await readers.getSections(uid)).map((s) => ({ title: [s.course_title, s.section_title].filter(Boolean).join(': ') }));
  }
  details.groups = (await readers.getGroups(uid)).map((g) => ({ title: g.title, category: g.category || null }));
  return {
    kind,
    name_display: rest.name_display || [rest.name_first, rest.name_last].filter(Boolean).join(' '),
    name_first: rest.name_first || null,
    name_first_preferred: rest.name_first_preferred || null,
    name_last: rest.name_last || null,
    email: rest.primary_email || null,
    picture_url: rest.picture_url || null,
    details,
  };
}

// A profiled person who has since become a Prism student (Graham, 28 Oct 2026: a student profiled before he teaches
// them): their notes move to the student's own notes, oldest first, and the profile is removed. `uid` limits it to one
// person; omitted, every such profile. → the number of profiles moved.
export function adoptProfiledStudents(db, uid = null) {
  const rows = db.prepare(`SELECT p.schoology_uid, s.id AS student_id FROM people p JOIN students s ON s.schoology_uid = p.schoology_uid
    WHERE ? IS NULL OR p.schoology_uid = ?`).all(uid, uid);
  if (!rows.length) return 0;
  db.transaction(() => {
    for (const r of rows) {
      db.prepare(`INSERT INTO notes (student_id, content, created_at, updated_at)
        SELECT ?, content, created_at, created_at FROM people_notes WHERE schoology_uid = ? ORDER BY created_at, id`).run(r.student_id, r.schoology_uid);
      db.prepare('DELETE FROM people_notes WHERE schoology_uid = ?').run(r.schoology_uid);
      db.prepare('DELETE FROM people WHERE schoology_uid = ?').run(r.schoology_uid);
    }
  })();
  return rows.length;
}

// Delete one profile and its notes, on the teacher's request. → true when there was one.
export function deletePerson(db, uid) {
  return db.transaction(() => {
    db.prepare('DELETE FROM people_notes WHERE schoology_uid = ?').run(String(uid));
    return db.prepare('DELETE FROM people WHERE schoology_uid = ?').run(String(uid)).changes > 0;
  })();
}

const shaped = (row, notes) => ({
  schoology_uid: row.schoology_uid, kind: row.kind, name_display: row.name_display, name_first: row.name_first,
  name_first_preferred: row.name_first_preferred, name_last: row.name_last, email: row.email, picture_url: row.picture_url,
  ...JSON.parse(row.details_json || '{}'), read_at: row.read_at, notes,
});

/**
 * The profile for People search's uid. A Prism student → { student_id } (open their student page). Otherwise read
 * from Schoology when not stored, stored more than REREAD_AFTER_DAYS ago, or `refresh`; marked viewed.
 * → { profile } with the notes, newest first; children that are Prism students carry student_id. When a stored
 * profile cannot be read again, it is returned as stored with read_error (why) and its read_at unchanged.
 */
export async function getPersonProfile(db, uid, { readers, refresh = false, now = new Date() } = {}) {
  const id = String(uid || '').trim();
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('A Schoology user id is a number'), { status: 400 });
  const student = db.prepare('SELECT id FROM students WHERE schoology_uid = ?').get(id);
  if (student) { adoptProfiledStudents(db, id); return { student_id: student.id }; }
  adoptProfiledStudents(db); // anyone profiled who has since joined a class
  const at = now.toISOString();
  let row = db.prepare('SELECT * FROM people WHERE schoology_uid = ?').get(id);
  const stale = !row || refresh || Date.parse(row.read_at) < now.getTime() - REREAD_AFTER_DAYS * DAY;
  let readError = null;
  let fresh = null;
  if (stale) {
    try {
      fresh = await readPerson(id, readers);
    } catch (err) {
      // Graham, 28 Oct 2026: a profile opened long after its last read (a student since graduated, a lapsed session)
      // still shows what was read, dated, with why it could not be read again. With nothing stored the error goes up.
      if (!row || err.status === 400) throw err;
      readError = err.needsLogin ? 'the Schoology session has expired' : err.message;
    }
  }
  if (fresh) {
    const p = fresh;
    db.prepare(`INSERT INTO people (schoology_uid, kind, name_display, name_first, name_first_preferred, name_last, email, picture_url, details_json, read_at, last_viewed_at)
      VALUES (@uid, @kind, @name_display, @name_first, @name_first_preferred, @name_last, @email, @picture_url, @details, @at, @at)
      ON CONFLICT(schoology_uid) DO UPDATE SET kind = excluded.kind, name_display = excluded.name_display, name_first = excluded.name_first,
        name_first_preferred = excluded.name_first_preferred, name_last = excluded.name_last, email = excluded.email,
        picture_url = excluded.picture_url, details_json = excluded.details_json, read_at = excluded.read_at, last_viewed_at = excluded.last_viewed_at`)
      .run({ uid: id, ...p, details: JSON.stringify(p.details), at });
  } else {
    db.prepare('UPDATE people SET last_viewed_at = ? WHERE schoology_uid = ?').run(at, id);
  }
  row = db.prepare('SELECT * FROM people WHERE schoology_uid = ?').get(id);
  const notes = db.prepare('SELECT id, content, created_at FROM people_notes WHERE schoology_uid = ? ORDER BY created_at DESC, id DESC').all(id);
  const profile = { ...shaped(row, notes), read_error: readError };
  const studentOf = db.prepare('SELECT id FROM students WHERE schoology_uid = ?');
  for (const list of [profile.children, profile.parents]) for (const x of list || []) {
    const s = x.uid && studentOf.get(x.uid);
    if (s) x.student_id = s.id;
  }
  return { profile };
}

// Notes on a stored profile. → the note.
export function addPersonNote(db, uid, content, now = new Date()) {
  const body = String(content || '').trim();
  if (!body) throw Object.assign(new Error('A note needs some text'), { status: 400 });
  if (!db.prepare('SELECT 1 FROM people WHERE schoology_uid = ?').get(String(uid))) throw Object.assign(new Error('No profile for this person'), { status: 404 });
  const at = now.toISOString();
  const id = db.prepare('INSERT INTO people_notes (schoology_uid, content, created_at) VALUES (?, ?, ?)').run(String(uid), body, at).lastInsertRowid;
  return { id, content: body, created_at: at };
}

export function deletePersonNote(db, uid, noteId) {
  return db.prepare('DELETE FROM people_notes WHERE id = ? AND schoology_uid = ?').run(Number(noteId), String(uid)).changes > 0;
}
