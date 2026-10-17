// PowerSchool's teacher web surface over plain HTTP, no browser (#117, #141).
//
// The session comes from the Schoology "attendance" LTI tool, as the browser gets
// it: GET the tool's run URL on Schoology with the saved Schoology session → an
// auto-submit form signed by Schoology (OAuth 1.0a LTI fields, custom_sectiondcid,
// custom_userdcid) → POST those fields to the form's action on PowerSchool, which
// answers 200 with the attendance app and sets PowerSchool's session cookies
// (JSESSIONID, psaid). Those cookies then carry the /teachers/mba_alerts/queries/
// reads. Verified live 2026-10-17 (scripts/probe-ps-alerts-http.js); see
// .claude/powerschool-api-reference.md "Student alerts (#117)".
//
// Read only: every PowerSchool call here is a read (the plugin's own reads are
// POSTs, as jQuery.post sends them).
import { getPage, WebSessionError } from './schoologyWeb.js';
import { sectionDcidFromLaunchForm } from '../lib/psBlockNumber.js';

export const PS_BASE = 'https://powerschool.hkis.edu.hk';
export const ATTENDANCE_APP_ID = '4980125287';
const PS_HOST = new URL(PS_BASE).host;
const TIMEOUT_MS = 20000;

export const runPath = (schoologySectionId) => `/apps/lti/${ATTENDANCE_APP_ID}/run/course/${schoologySectionId}`;

const decode = (v) => v.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? '') : null;
};

// The LTI launch form on the run page → { action, fields }, or null.
export function launchForm(html) {
  if (!html || typeof html !== 'string') return null;
  const open = html.match(/<form\b[^>]*>/i);
  if (!open) return null;
  const action = attr(open[0], 'action');
  if (!action) return null;
  const end = html.indexOf('</form>', open.index);
  const body = html.slice(open.index, end < 0 ? undefined : end);
  const fields = {};
  for (const [tag] of body.matchAll(/<input\b[^>]*>/gi)) {
    const name = attr(tag, 'name');
    if (name) fields[name] = attr(tag, 'value') ?? '';
  }
  return { action, fields };
}

// A cookie jar for the PowerSchool host, filled by its Set-Cookie answers.
function psJar() {
  const jar = new Map();
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
    get size() { return jar.size; },
  };
}

// Parse an answer the plugin reads as JSON (some come back as text/html).
function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

export class PowerSchoolWeb {
  // sgyJar: the Schoology session jar (schoologyWeb.cookieJar()).
  constructor({ sgyJar, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
    this.sgyJar = sgyJar;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.jar = psJar();
    this.launched = false;
  }

  // Read a section's launch form from Schoology → { sectionDcid, form }. Throws
  // WebSessionError SESSION_EXPIRED when Schoology sends the session to sign-in.
  async launchIds(schoologySectionId) {
    const { html } = await getPage(this.sgyJar, runPath(schoologySectionId), { fetchImpl: this.fetchImpl });
    return { sectionDcid: sectionDcidFromLaunchForm(html), form: launchForm(html) };
  }

  // Start (or restart) the PowerSchool session by posting a section's launch form.
  // A form is signed with a nonce, so each launch reads a fresh one.
  async launch(schoologySectionId) {
    const { form } = await this.launchIds(schoologySectionId);
    if (!form || !form.action.startsWith(PS_BASE)) {
      throw new WebSessionError('PS_LAUNCH', 'Schoology did not give a PowerSchool launch form');
    }
    let url = form.action;
    let init = { method: 'POST', body: new URLSearchParams(form.fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
    for (let hop = 0; hop < 6; hop++) {
      const res = await this.fetchImpl(url, { ...init, headers: { ...init.headers, cookie: this.jar.header() }, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
      this.jar.take(res);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        url = new URL(res.headers.get('location') || '', url).href;
        if (new URL(url).host !== PS_HOST) throw new WebSessionError('PS_LAUNCH', 'PowerSchool sent the launch to sign-in');
        init = { method: 'GET', headers: {} };
        continue;
      }
      if (res.status !== 200) throw new WebSessionError('PS_LAUNCH', `PowerSchool answered ${res.status} to the launch`);
      await res.text();
      if (!this.jar.size) throw new WebSessionError('PS_LAUNCH', 'PowerSchool gave no session');
      this.launched = true;
      return;
    }
    throw new WebSessionError('PS_LAUNCH', 'Too many redirects on the PowerSchool launch');
  }

  // One plugin read. → parsed JSON. A redirect, an error status or a page that is
  // not JSON means the PowerSchool session is gone: PS_SESSION.
  async read(path, params, { method = 'POST' } = {}) {
    const query = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
    const url = method === 'GET' ? `${PS_BASE}${path}${path.includes('?') ? '&' : '?'}${query}` : `${PS_BASE}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      ...(method === 'POST' ? { body: query.toString() } : {}),
      headers: {
        cookie: this.jar.header(),
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.jar.take(res);
    const text = await res.text();
    if (res.status !== 200) throw new WebSessionError('PS_SESSION', `PowerSchool answered ${res.status} for ${path.split('?')[0]}`);
    const json = parseJson(text);
    if (json === undefined) throw new WebSessionError('PS_SESSION', `PowerSchool answered ${path.split('?')[0]} with a page, not data`);
    return json;
  }
}
