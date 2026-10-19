// Spike (#141, read-only): can SharePoint (the teacher's OneDrive) be reached over plain HTTP with the
// saved session's Microsoft sign-in cookies, without a browser? Follows SharePoint's sign-in by hand:
// the redirect to login.microsoftonline.com, Microsoft's answer (an auto-submitting form_post page when
// the remembered sign-in is enough), the POST back to SharePoint, then one REST read (GetMyProperties).
// Prints each hop's status, host, path, and the NAMES of cookies set and form fields: never values,
// query strings or tokens. Never writes the saved session file.
//
// Usage: [PRISM_SESSION_DIR=…] node scripts/probe-sharepoint-http.js
import 'dotenv/config';
import { readFileSync } from 'fs';
import { sessionStateFile } from '../server/lib/sessionPaths.js';
import { getMicrosoftConfig } from '../server/middleware/featureGate.js';

const origin = new URL(getMicrosoftConfig().sharepointHost).origin;
const state = JSON.parse(readFileSync(sessionStateFile(), 'utf8'));

// A cookie jar across hosts: domain → name → value. A cookie for "x.com" goes to x.com and its subdomains.
const jar = new Map();
const put = (domain, name, value) => {
  const d = domain.replace(/^\./, '').toLowerCase();
  if (!jar.has(d)) jar.set(d, new Map());
  jar.get(d).set(name, value);
};
for (const c of state.cookies || []) if (!/schoology/.test(c.domain)) put(c.domain, c.name, c.value);
const header = (host) => [...jar].filter(([d]) => host === d || host.endsWith(`.${d}`)).flatMap(([, m]) => [...m].map(([k, v]) => `${k}=${v}`)).join('; ');
const take = (res, host) => {
  const names = [];
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = line.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const domain = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a))?.slice(7) || host;
    put(domain, pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    names.push(pair.slice(0, i).trim());
  }
  return names;
};
const show = (u) => `${u.host}${u.pathname}`;

async function request(url, init = {}) {
  const u = new URL(url);
  const res = await fetch(url, { ...init, redirect: 'manual', headers: { cookie: header(u.host), 'User-Agent': 'Mozilla/5.0', ...init.headers } });
  const set = take(res, u.host);
  const text = await res.text();
  const location = res.headers.get('location');
  console.log(`${init.method || 'GET'} ${show(u)} → ${res.status}${location ? ` → ${show(new URL(location, url))}` : ''}${set.length ? `; set ${set.join(', ')}` : ''}`);
  return { status: res.status, location: location ? new URL(location, url).href : null, text, url };
}

// A form Microsoft asks the browser to submit (form_post): its action and hidden fields.
function formPost(html, base) {
  const form = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  const fields = [...form[2].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)].map((m) => [m[1], m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"')]);
  return { action: new URL(form[1].replace(/&amp;/g, '&'), base).href, fields };
}

let r = await request(`${origin}/_layouts/15/onedrive.aspx`);
for (let hops = 0; hops < 12; hops++) {
  if (r.location) { r = await request(r.location); continue; }
  if (r.status === 200 && new URL(r.url).host !== new URL(origin).host) {
    const f = formPost(r.text, r.url);
    if (!f) {
      const title = r.text.match(/<title>([^<]*)<\/title>/i)?.[1];
      console.log(`  a page without a form (title "${title ?? ''}", ${r.text.length} chars, $Config ${/\$Config=/.test(r.text) ? 'present' : 'absent'}, pgid ${r.text.match(/"pgid":"([^"]+)"/)?.[1] ?? '-'})`);
      break;
    }
    console.log(`  form_post to ${show(new URL(f.action))}, fields ${f.fields.map(([k]) => k).join(', ')}`);
    r = await request(f.action, { method: 'POST', body: new URLSearchParams(f.fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    continue;
  }
  break;
}
const onSharePoint = new URL(r.url).host === new URL(origin).host && r.status === 200;
console.log(`landed: ${show(new URL(r.url))} ${r.status} (${onSharePoint ? 'on SharePoint' : 'NOT on SharePoint'}); SharePoint cookies now: ${[...(jar.get(new URL(origin).host) ?? new Map()).keys()].join(', ') || 'none'}`);

const t = Date.now();
const me = await request(`${origin}/_api/SP.UserProfiles.PeopleManager/GetMyProperties?$select=PersonalUrl`, { headers: { Accept: 'application/json;odata=nometadata' } });
let personal = null;
try { personal = JSON.parse(me.text).PersonalUrl; } catch { /* not JSON */ }
console.log(`GetMyProperties: ${me.status}, PersonalUrl ${personal ? new URL(personal).pathname : 'absent'} (${Date.now() - t} ms)`);
