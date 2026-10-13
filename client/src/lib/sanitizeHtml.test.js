import { it, expect } from 'vitest';
import { sanitizeAnswerHtml } from './sanitizeHtml.js';

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
