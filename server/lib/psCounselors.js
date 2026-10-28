// A student's counselors (#190): PowerSchool's GET /ws/studentcounselor/{studentDcid}, the read behind the counselor
// icon in a PowerTeacher student page's header, and the student's Schoology Advisors row for their emails.
// Probed 28/10/2026 (.claude/powerschool-api-reference.md "Student counsellors (#190)"): an array of
// { id, studentDcid, userDcid, userFirstName, userLastName, isPrimary, @extensions }, 2 counselors per student and
// exactly 1 isPrimary (3 of 3). The record has no email; for 6 of 6 counselors exactly one person in the student's
// Schoology Advisors row (/user/{uid}/info) matched by first (or preferred first) and last name, with an
// @hkis.edu.hk primary_email (.claude/schoology-api-reference.md "1a. Another user's profile").

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

// The read's answer → [{ userDcid, firstName, lastName, isPrimary }], or null when it is not this student's list
// (not an array, a record for another student, a record with no user or no name): nothing is stored then.
export function parseCounselors(json, studentDcid) {
  if (!Array.isArray(json)) return null;
  const out = [];
  for (const c of json) {
    if (!c || typeof c !== 'object') return null;
    if (String(c.studentDcid) !== String(studentDcid)) return null;
    const userDcid = c.userDcid == null ? '' : String(c.userDcid);
    const firstName = clean(c.userFirstName);
    const lastName = clean(c.userLastName);
    if (!userDcid || (!firstName && !lastName)) return null;
    if (out.some((o) => o.userDcid === userDcid)) continue;
    out.push({ userDcid, firstName, lastName, isPrimary: c.isPrimary === true });
  }
  return out;
}

// The Schoology uids in a profile Info page's Advisors row (<tr><th>Advisors</th><td>links</td></tr>), in order.
export function advisorUids(html) {
  for (const [, row] of String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const th = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(row);
    if (!th || th[1].replace(/<[^>]+>/g, '').trim() !== 'Advisors') continue;
    return [...new Set([...row.matchAll(/href="\/user\/(\d+)/g)].map((m) => m[1]))];
  }
  return [];
}

const fold = (v) => clean(v).toLowerCase();

// The one Schoology profile (from GET /v1/users/{uid}) that is this counselor: last name equal and first name equal to
// the profile's first or preferred first name, case-folded. → the profile, or null when none or more than one match.
export function matchAdvisor(counselor, profiles) {
  const hits = profiles.filter((p) => p && fold(p.name_last) === fold(counselor.lastName)
    && [p.name_first, p.name_first_preferred].map(fold).includes(fold(counselor.firstName)));
  return hits.length === 1 ? hits[0] : null;
}
