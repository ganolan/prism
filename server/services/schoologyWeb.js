// Schoology's web (Drupal) surface over plain HTTP: the saved session's cookies
// on fetch, no browser. AGENTS.md: a headless browser only where no HTTP route
// exists. What this reads and sends is documented in
// .claude/schoology-api-reference.md ("Submission comment threads").
import { readFileSync, existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { sessionStateFile } from '../lib/sessionPaths.js';

export class WebSessionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const HOST = new URL(SCHOOLOGY_BASE).host;

// A cookie jar seeded from the saved session (storage-state.json), for the school
// host only. Set-Cookie answers update it, so a refreshed session cookie is used
// on the next request. Expiry stamps are ignored: they read "expired" long before
// the Drupal session dies (AGENTS.md); the server decides.
export function cookieJar(stateFile = sessionStateFile()) {
  if (!existsSync(stateFile)) return null;
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const jar = new Map();
  for (const c of state.cookies || []) {
    const domain = String(c.domain || '').replace(/^\./, '');
    if (HOST === domain || HOST.endsWith(`.${domain}`)) jar.set(c.name, c.value);
  }
  return {
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    take(res) {
      const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const line of set) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
  };
}

// GET a school page with the session. Throws SESSION_EXPIRED when Schoology
// sends the request to the login / SSO page.
export async function getPage(jar, path, { fetchImpl = fetch } = {}) {
  let url = path.startsWith('http') ? path : `${SCHOOLOGY_BASE}${path}`;
  for (let i = 0; i < 5; i++) {
    const res = await fetchImpl(url, { headers: { cookie: jar.header() }, redirect: 'manual' });
    jar.take(res);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location') || '';
      url = location.startsWith('http') ? location : new URL(location, url).href;
      if (!isLoggedInUrl(url)) throw new WebSessionError('SESSION_EXPIRED', 'The saved Schoology session has expired');
      continue;
    }
    if (res.status !== 200) throw new WebSessionError('HTTP', `Schoology answered ${res.status} for ${new URL(url).pathname}`);
    return { url, html: await res.text() };
  }
  throw new WebSessionError('HTTP', 'Too many redirects');
}

// The page's Drupal.settings object (CSRF token and key, upload settings).
export function drupalSettings(html) {
  const m = html.match(/jQuery\.extend\(Drupal\.settings,\s*(\{.*?\})\);\s*(?:\/\/-->\s*)?(?:\]\]>\s*)?<\/script>/s)
    || html.match(/jQuery\.extend\(Drupal\.settings,\s*(\{.*?\})\);/s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

const decode = (v) => v.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name.replace(/[[\]]/g, '\\$&')}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? '') : null;
};

// One form's markup and its fields: { action, inputs: { name: value }, submit: { name, value } }.
// Hidden and text inputs keep their values; a textarea is listed with its text.
export function formFields(html, formId) {
  const start = html.search(new RegExp(`<form[^>]*\\sid="${formId}"`));
  if (start < 0) return null;
  const end = html.indexOf('</form>', start);
  const form = html.slice(start, end < 0 ? undefined : end);
  const open = form.slice(0, form.indexOf('>') + 1);
  const inputs = {}; let submit = null;
  for (const [tag] of form.matchAll(/<input\b[^>]*>/gi)) {
    const name = attr(tag, 'name'); const type = (attr(tag, 'type') || 'text').toLowerCase();
    if (!name) continue;
    if (type === 'submit') { submit ??= { name, value: attr(tag, 'value') || '' }; continue; }
    if (type === 'file' || type === 'button' || type === 'checkbox' || type === 'radio') continue;
    inputs[name] = attr(tag, 'value') ?? '';
  }
  for (const m of form.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const name = attr(m[1], 'name');
    if (name) inputs[name] = decode(m[2]);
  }
  return { action: attr(open, 'action'), inputs, submit, hasFileInput: /<input\b[^>]*type="file"/i.test(form) };
}

// Upload a file the way the page's plupload widget does: multipart POSTs to
// s_attachment.upload_url, field "file" plus use_plain, name, chunk, chunks, and
// the fid from the first answer on later chunks; X-Csrf-Token / X-Csrf-Key headers.
// chunk_size is in KB (s_attachment_form.js appends 'kb'; a 671 KB file went up
// in one request). → the new file's fid.
export async function uploadAttachment(jar, settings, { name, bytes, mime = 'application/octet-stream' }, { fetchImpl = fetch } = {}) {
  const csrf = settings?.s_common;
  const up = settings?.s_attachment;
  if (!csrf?.csrf_token || !csrf?.csrf_key || !up?.upload_url) {
    throw new WebSessionError('NO_UPLOAD', 'The page has no file upload settings');
  }
  const chunkBytes = Math.max(1, Number(up.chunk_size) || 70000) * 1024;
  const chunks = Math.max(1, Math.ceil(bytes.length / chunkBytes));
  let fid = null;
  for (let chunk = 0; chunk < chunks; chunk++) {
    const body = new FormData();
    body.append('use_plain', '1');
    if (fid) body.append('fid', String(fid));
    body.append('name', name);
    body.append('chunk', String(chunk));
    body.append('chunks', String(chunks));
    body.append('file', new Blob([bytes.subarray(chunk * chunkBytes, (chunk + 1) * chunkBytes)], { type: mime }), name);
    const res = await fetchImpl(`${SCHOOLOGY_BASE}${up.upload_url}`, {
      method: 'POST', body,
      headers: { cookie: jar.header(), 'X-Csrf-Token': csrf.csrf_token, 'X-Csrf-Key': csrf.csrf_key },
    });
    jar.take(res);
    const text = (await res.text()).replace(/(^<pre>|<\/pre>$)/g, '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* reported below */ }
    if (res.status !== 200 || !json || json.error) {
      const why = json?.error?.message || `HTTP ${res.status}`;
      throw new WebSessionError('UPLOAD_FAILED', `Schoology refused the upload (${why})`);
    }
    fid = json.file?.fid || json.fileMetadataId || fid;
    if (!fid) throw new WebSessionError('UPLOAD_FAILED', 'Schoology answered the upload without a file id');
  }
  return String(fid);
}

// Submit a Drupal form the way its AJAX submit button does: urlencoded fields
// plus the button and drupal_ajax=1, with X-Requested-With. → { status, json }.
export async function submitAjaxForm(jar, pageUrl, fields, { fetchImpl = fetch } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.append(k, v ?? '');
  body.append('drupal_ajax', '1');
  const res = await fetchImpl(pageUrl, {
    method: 'POST', body: body.toString(),
    headers: {
      cookie: jar.header(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  });
  jar.take(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
