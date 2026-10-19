import { describe, test, expect } from 'vitest';
import { stateCookieJar, USER_AGENT } from './stateCookieJar.js';

const answer = (lines) => ({ headers: { getSetCookie: () => lines } });
const NOW = Date.parse('2026-10-19T12:00:00Z');

describe('stateCookieJar', () => {
  const saved = [
    { name: 'ESTSAUTHPERSISTENT', value: 'p', domain: '.login.microsoftonline.com', path: '/', expires: 1800000000, httpOnly: true, secure: true, sameSite: 'None' },
    { name: 'SESSa', value: 'old', domain: '.schoology.hkis.edu.hk', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'host', value: 'h', domain: 'schoology.hkis.edu.hk', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' },
  ];

  test('sends a cookie to its domain and subdomains; a host-only cookie to its host only', () => {
    const jar = stateCookieJar(saved);
    expect(jar.header('https://login.microsoftonline.com/x')).toBe('ESTSAUTHPERSISTENT=p');
    expect(jar.header('https://schoology.hkis.edu.hk/home')).toBe('SESSa=old; host=h');
    expect(jar.header('https://x.schoology.hkis.edu.hk/')).toBe('SESSa=old');
    expect(jar.header('https://app.schoology.com/')).toBe('');
  });

  test('`exclude` leaves cookies out of the jar', () => {
    const jar = stateCookieJar(saved, { exclude: (c) => /schoology/.test(c.domain) });
    expect(jar.header('https://schoology.hkis.edu.hk/home')).toBe('');
  });

  test('Set-Cookie replaces a cookie, keeps the saved format, and adds new ones', () => {
    const jar = stateCookieJar(saved, { now: () => NOW });
    jar.take(answer(['SESSa=new; path=/; domain=.schoology.hkis.edu.hk; secure; HttpOnly', 'buid=b; Max-Age=3600; path=/; secure; SameSite=None']), 'https://login.microsoftonline.com/authorize');
    expect(jar.header('https://schoology.hkis.edu.hk/home')).toBe('SESSa=new; host=h');
    const out = jar.cookies();
    expect(out.find((c) => c.name === 'SESSa')).toEqual({ name: 'SESSa', value: 'new', domain: '.schoology.hkis.edu.hk', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });
    expect(out.find((c) => c.name === 'buid')).toEqual({ name: 'buid', value: 'b', domain: 'login.microsoftonline.com', path: '/', expires: NOW / 1000 + 3600, httpOnly: false, secure: true, sameSite: 'None' });
    expect(out).toHaveLength(4);
  });

  test('an expiring Set-Cookie (Max-Age=0 or a past Expires) removes the cookie, as a browser does', () => {
    const jar = stateCookieJar(saved, { now: () => NOW });
    jar.take(answer(['host=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; path=/']), 'https://schoology.hkis.edu.hk/home');
    jar.take(answer(['SESSa=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; path=/; domain=.schoology.hkis.edu.hk']), 'https://schoology.hkis.edu.hk/home');
    expect(jar.header('https://schoology.hkis.edu.hk/home')).toBe('');
    expect(jar.cookies().map((c) => c.name)).toEqual(['ESTSAUTHPERSISTENT']);
  });

  test('a browser-like User-Agent', () => {
    expect(USER_AGENT).toMatch(/^Mozilla\/5\.0 /);
  });
});
