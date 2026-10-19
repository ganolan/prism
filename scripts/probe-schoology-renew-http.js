// Spike (#141, read-only): can a lapsed Schoology session be renewed through Microsoft over plain HTTP,
// without a browser? Takes a COPY of the saved session in memory, drops every Schoology SESS… cookie
// (as the #136 browser renewal probe did, 2026-10-18), then follows GET /home by hand: Schoology's
// send-to-Microsoft redirect, Microsoft's answer (a redirect, or an auto-submitting form), and the
// way back to Schoology. Then checks /home answers 200 with the CSRF pair. Prints each hop's status,
// host, path, and the NAMES of cookies set and form fields: never values, query strings or tokens.
// Never writes the saved session file.
//
// Usage: [PRISM_SESSION_DIR=…] node scripts/probe-schoology-renew-http.js
import 'dotenv/config';
import { readFileSync } from 'fs';
import { sessionStateFile } from '../server/lib/sessionPaths.js';

const SCHOOLOGY = 'https://schoology.hkis.edu.hk';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Prism';
const state = JSON.parse(readFileSync(sessionStateFile(), 'utf8'));
const dropped = state.cookies.filter((c) => /schoology/.test(c.domain) && /^S?SESS/.test(c.name));
console.log(`dropped ${dropped.length} Schoology session cookies: ${dropped.map((c) => `${c.domain} ${c.name.slice(0, 6)}…`).join(', ')}`);

const jar = new Map();
const put = (domain, name, value) => {
  const d = domain.replace(/^\./, '').toLowerCase();
  if (!jar.has(d)) jar.set(d, new Map());
  jar.get(d).set(name, value);
};
for (const c of state.cookies) if (!dropped.includes(c)) put(c.domain, c.name, c.value);
const header = (host) => [...jar].filter(([d]) => host === d || host.endsWith(`.${d}`)).flatMap(([, m]) => [...m].map(([k, v]) => `${k}=${v}`)).join('; ');
const take = (res, host) => {
  const names = [];
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = line.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const domain = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a))?.slice(7) || host;
    // An expiring Set-Cookie (Max-Age=0, or an expiry in the past) removes the cookie, as a browser does.
    const maxAge = attrs.map((a) => a.trim()).find((a) => /^max-age=/i.test(a))?.slice(8);
    const expires = attrs.map((a) => a.trim()).find((a) => /^expires=/i.test(a))?.slice(8);
    if ((maxAge != null && Number(maxAge) <= 0) || (expires && Date.parse(expires) < Date.now())) {
      jar.get(domain.replace(/^\./, '').toLowerCase())?.delete(pair.slice(0, i).trim());
      continue;
    }
    put(domain, pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    names.push(/^S?SESS/.test(pair) ? `${pair.slice(0, 6)}…` : pair.slice(0, i).trim());
  }
  return names;
};
const show = (u) => `${u.host}${u.pathname}`;
async function request(url, init = {}) {
  const u = new URL(url);
  const res = await fetch(url, { ...init, redirect: 'manual', headers: { cookie: header(u.host), 'User-Agent': UA, ...init.headers } });
  const set = take(res, u.host);
  const text = await res.text();
  const location = res.headers.get('location');
  console.log(`${init.method || 'GET'} ${show(u)} → ${res.status}${location ? ` → ${show(new URL(location, url))}` : ''}${set.length ? `; set ${set.join(', ')}` : ''}`);
  return { status: res.status, location: location ? new URL(location, url).href : null, text, url };
}
function formPost(html, base) {
  const form = html.match(/<form\b[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  const fields = [...form[2].matchAll(/<input\b[^>]*>/gi)].map(([t]) => t).filter((t) => /type="hidden"/i.test(t))
    .map((t) => [t.match(/\bname="([^"]*)"/i)?.[1], (t.match(/\bvalue="([^"]*)"/i)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')]).filter(([n]) => n);
  return { action: new URL(form[1].replace(/&amp;/g, '&'), base).href, fields };
}

const t0 = Date.now();
let r = await request(`${SCHOOLOGY}/home`);
for (let hops = 0; hops < 15; hops++) {
  if (r.location) { r = await request(r.location); continue; }
  const host = new URL(r.url).host;
  if (r.status === 200 && /microsoftonline|windows\.net|live\.com/.test(host)) {
    const f = formPost(r.text, r.url);
    if (!f) {
      console.log(`  a Microsoft page without a form (title "${r.text.match(/<title>([^<]*)/i)?.[1] ?? ''}", pgid ${r.text.match(/"pgid":"([^"]+)"/)?.[1] ?? '-'}): Microsoft wants a real sign-in`);
      break;
    }
    console.log(`  form to ${show(new URL(f.action))}, fields ${f.fields.map(([k]) => k).join(', ')}`);
    r = await request(f.action, { method: 'POST', body: new URLSearchParams(f.fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    continue;
  }
  break;
}
const landed = new URL(r.url);
console.log(`landed: ${show(landed)} ${r.status} after ${Date.now() - t0} ms`);
const settings = r.text.match(/"s_common":\{[^}]*"csrf_token":"[^"]+"/);
console.log(`signed in to Schoology: ${landed.host === new URL(SCHOOLOGY).host && landed.pathname === '/home' && r.status === 200 && settings ? 'YES (home with the CSRF pair)' : 'NO'}`);
console.log(`Schoology session cookies now: ${[...jar].filter(([d]) => /schoology/.test(d)).flatMap(([d, m]) => [...m.keys()].filter((k) => /^S?SESS/.test(k)).map((k) => `${d} ${k.slice(0, 6)}…`)).join(', ') || 'none'}`);
