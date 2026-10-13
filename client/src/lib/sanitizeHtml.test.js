import { it, expect } from 'vitest';
import { sanitizeAnswerHtml, sanitizeStemHtml } from './sanitizeHtml.js';

it('keeps text formatting, lists and code', () => {
  expect(sanitizeAnswerHtml('<p>a) <strong>bold</strong><br>next</p><pre><code>x ← 1</code></pre><ul><li>i</li></ul>'))
    .toBe('<p>a) <strong>bold</strong><br>next</p><pre><code>x ← 1</code></pre><ul><li>i</li></ul>');
});

it('removes anything that runs, loads or links', () => {
  const out = sanitizeAnswerHtml('<p onclick="x()">hi</p><script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">link</a><iframe src="https://e.com"></iframe><p style="background:url(x)">s</p>');
  expect(out).toBe('<p>hi</p>link<p>s</p>');
});

it('treats null as empty', () => {
  expect(sanitizeAnswerHtml(null)).toBe('');
});

it('keeps no data- or aria- attributes', () => {
  expect(sanitizeAnswerHtml('<p data-x="1" aria-label="y">hi</p>')).toBe('<p>hi</p>');
});

it('a stem keeps an http(s) image with its alt text, and nothing that runs', () => {
  const out = sanitizeStemHtml('<p>Look:</p><img src="https://schoology.hkis.edu.hk/system/files/a.png" alt="diagram" onerror="alert(1)" width="9"><img src="javascript:alert(1)"><img src="data:image/png;base64,AAAA"><script>x()</script>');
  const doc = new DOMParser().parseFromString(out, 'text/html');
  const imgs = [...doc.querySelectorAll('img')].map(i => Object.fromEntries([...i.attributes].map(a => [a.name, a.value])));
  expect(imgs).toEqual([{ src: 'https://schoology.hkis.edu.hk/system/files/a.png', alt: 'diagram' }, {}, {}]);
  expect(doc.body.textContent).toBe('Look:');
  expect(out).not.toMatch(/script|onerror|javascript|data:/);
});

it('an answer still drops images', () => {
  expect(sanitizeAnswerHtml('<img src="https://e.com/a.png" alt="a">')).toBe('');
});
