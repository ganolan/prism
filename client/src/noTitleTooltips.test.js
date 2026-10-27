import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from '@babel/parser';

// Teacher rule (AGENTS.md "Frontend Conventions", Graham 25 Oct 2026): hover text is an instant
// popover, never a native `title` tooltip, which opens too slowly. Text a user needs on mouseover goes
// through `Tip` / `useHelpPop` (components/HelpDot.jsx), with an aria-label holding the same text
// (#199). This guard parses every non-test .jsx file under client/src and fails on a `title=`
// attribute on a DOM element (a lowercase JSX tag such as <span>, <td>, <button>), on a component
// that passes it on to one (FORWARDING), and on an SVG <title>. A `title` prop on one of Prism's own
// components (<PrivateHidden title=...>, <PanelHead title=...>) is just a prop and passes.

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url));

// DOM elements whose `title` is not a tooltip. An <iframe>'s title is its accessible name, which
// WCAG requires; browsers show no tooltip for it.
const ALLOWED_TAGS = new Set(['iframe']);

// Components that pass a `title` straight on to their DOM element (react-router's links render an
// <a>; Tip spreads its other props on its element).
const FORWARDING = new Set(['Link', 'NavLink', 'Tip']);

function listJsxFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsxFiles(full, files);
    else if (entry.name.endsWith('.jsx') && !entry.name.includes('.test.')) files.push(full);
  }
  return files;
}

const tagName = (name) => (name.type === 'JSXIdentifier' ? name.name : null);

// Parsed, not pattern-matched, so a `>` or an apostrophe inside an attribute's expression cannot
// hide one, and a `title` in a comment or a string is not one.
function findTitleTooltips(source) {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const found = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'JSXOpeningElement') {
      const tag = tagName(node.name);
      if (tag === 'title') {
        found.push({ tag, line: node.loc.start.line });
      } else if (tag && (/^[a-z]/.test(tag) || FORWARDING.has(tag)) && !ALLOWED_TAGS.has(tag)
        && node.attributes.some((a) => a.type === 'JSXAttribute' && a.name.name === 'title')) {
        found.push({ tag, line: node.loc.start.line });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast.program);
  return found;
}

describe('no native title tooltips (AGENTS.md: hover text is an instant popover)', () => {
  test('the scanner tells a DOM title from a component prop', () => {
    expect(findTitleTooltips('<span className="x" title="Late">L</span>')).toEqual([{ tag: 'span', line: 1 }]);
    expect(findTitleTooltips('<td\n  key={a.id}\n  title={t ? `${t} > 2` : undefined}>-</td>')).toEqual([{ tag: 'td', line: 1 }]);
    expect(findTitleTooltips("<p onMouseEnter={() => show(<b>couldn't</b>)} title=\"x\">y</p>")).toEqual([{ tag: 'p', line: 1 }]);
    expect(findTitleTooltips('<Link to="/a" title={r.name}>{r.name}</Link>')).toEqual([{ tag: 'Link', line: 1 }]);
    expect(findTitleTooltips('<svg><title>Late</title></svg>')).toEqual([{ tag: 'title', line: 1 }]);
    expect(findTitleTooltips('<PrivateHidden title="Grades are private." />')).toEqual([]);
    expect(findTitleTooltips('<Tip as="button" text="Copy" onClick={() => go({ title: a.title })}>Copy</Tip>')).toEqual([]);
    expect(findTitleTooltips('<span aria-label="x" data-title="y">{a.title}</span>')).toEqual([]);
    expect(findTitleTooltips('<iframe src={u} title={name} />')).toEqual([]);
    expect(findTitleTooltips('// <span title="x">\n/* <b title="y"> */\nconst a = 1;')).toEqual([]);
  });

  test('client/src has no title attribute on a DOM element', () => {
    const offenders = [];
    for (const file of listJsxFiles(SRC_ROOT)) {
      for (const hit of findTitleTooltips(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(SRC_ROOT, file)}:${hit.line}: <${hit.tag} title=...>`);
      }
    }
    expect(offenders, `Native title tooltips found (use Tip or useHelpPop from components/HelpDot.jsx, with an aria-label):\n${offenders.join('\n')}`).toEqual([]);
  });
});
