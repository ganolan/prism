/**
 * oneDriveSubmissions.js
 *
 * Pure helpers for resolving a student's OneDrive lti_submission file (#120).
 * The Schoology Microsoft OneDrive app keeps every student copy — in progress and
 * submitted — in the TEACHER's OneDrive:
 *
 *   Documents/Schoology Microsoft OneDrive Assignments/
 *     {COURSE} {section} - {sectionId}/{assignment title} - {assignmentId}/
 *       {First Last} - {assignment title} - {n}.pptx
 *
 * Folders are found by their " - {id}" suffix (course titles are sanitised, e.g.
 * "&" dropped). `{n}` matches no id Prism stores and SharePoint exposes no sharing
 * field tying a file to a student, so the filename's leading name is the only key.
 * See .claude/schoology-api-reference.md (OneDrive lti_submission file links).
 */

/** The folder (from a SharePoint `/Folders` listing) whose name ends " - {id}". */
export function findFolderById(folders, id) {
  if (!Array.isArray(folders)) return null;
  return folders.find(f => typeof f?.Name === 'string' && f.Name.endsWith(` - ${id}`)) ?? null;
}

// "{First Last} - {title, may itself contain ' - '} - {digits}.{ext}"
const FILE_RE = /^(.+?) - .+ - (\d+)\.[^.]+$/;

/** { studentName, fileNumber } for a student copy's filename, else null. */
export function parseSubmissionFileName(name) {
  const m = FILE_RE.exec(String(name ?? ''));
  return m ? { studentName: m[1], fileNumber: m[2] } : null;
}

/**
 * Browser URL for a file. SharePoint's `LinkingUrl` redirects to the Office web
 * editor (the same `Doc.aspx?sourcedoc=…&action=edit` link the teacher uses);
 * files Office can't open have no LinkingUrl, so fall back to the file itself.
 */
export function fileOpenUrl(file, origin) {
  if (file.LinkingUrl) return file.LinkingUrl;
  return `${origin}${encodeURI(file.ServerRelativeUrl)}`;
}

const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

function candidateNames(student) {
  const names = [`${student.first_name} ${student.last_name}`];
  if (student.preferred_name) names.push(`${student.preferred_name} ${student.last_name}`);
  return names.map(norm);
}

/**
 * Key an assignment folder's files to roster students by the name leading each
 * filename. A name that more than one student answers to links nobody (never
 * open the wrong student's work); a student with several files gets the most
 * recently modified one.
 *
 * @param {Array<{Name, ServerRelativeUrl, LinkingUrl, TimeLastModified}>} files
 * @param {Array<{schoology_uid, first_name, last_name, preferred_name}>} roster
 * @param {string} origin  e.g. https://hkis-my.sharepoint.com
 * @returns {Record<string, {url: string, fileName: string, modifiedAt: string}>} by schoology uid
 */
export function matchFilesToRoster(files, roster, origin) {
  const uidsByName = new Map();
  for (const s of roster) {
    for (const name of candidateNames(s)) {
      if (!uidsByName.has(name)) uidsByName.set(name, new Set());
      uidsByName.get(name).add(String(s.schoology_uid));
    }
  }

  const links = {};
  for (const f of files ?? []) {
    const parsed = parseSubmissionFileName(f.Name);
    if (!parsed) continue;
    const uids = uidsByName.get(norm(parsed.studentName));
    if (!uids || uids.size !== 1) continue;
    const [uid] = uids;
    const prev = links[uid];
    if (prev && prev.modifiedAt >= f.TimeLastModified) continue;
    links[uid] = { url: fileOpenUrl(f, origin), fileName: f.Name, modifiedAt: f.TimeLastModified };
  }
  return links;
}
