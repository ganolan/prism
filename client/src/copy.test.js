import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Teacher rule (AGENTS.md "Frontend Conventions"): no em dashes in UI copy,
// they take too much inline room. Use a hyphen, comma or colon instead.
// This guard reads every non-test source file under client/src, strips
// comments, and fails if a literal em dash (—) survives anywhere else
// (JSX text, string/template literals, attribute values, etc).
//
// Deliberately NOT a full JS tokenizer: a character-by-character scanner that
// also tracks quote state misfires on plain apostrophes in JSX text ("doesn't",
// "isn't" — not string delimiters), which either swallows real code into a
// phantom "string" or leaves comments unstripped. Comments in this codebase
// never nest and essentially never contain a bare `//`/`/*` inside a string
// (the one known exception, a `https://` URL, is special-cased below), so a
// simple line-oriented comment stripper is both simpler and more reliable here.

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url));
const EM_DASH = '—';

function listSourceFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, files);
    } else if (/\.jsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(full);
    }
  }
  return files;
}

// Returns [codeOnlyLine, stillInBlockComment]. Ignores a `//` immediately
// preceded by `:` (a `http://`/`https://` URL, not a line comment).
function stripLine(line, inBlock) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (inBlock) {
      const end = line.indexOf('*/', i);
      if (end === -1) return [out, true];
      i = end + 2;
      inBlock = false;
      continue;
    }
    let slashSlash = line.indexOf('//', i);
    while (slashSlash > 0 && line[slashSlash - 1] === ':') {
      slashSlash = line.indexOf('//', slashSlash + 2);
    }
    const slashStar = line.indexOf('/*', i);
    const candidates = [slashSlash, slashStar].filter((x) => x !== -1);
    if (candidates.length === 0) {
      out += line.slice(i);
      break;
    }
    const next = Math.min(...candidates);
    out += line.slice(i, next);
    if (next === slashSlash) break; // rest of the line is a line comment
    i = next + 2;
    inBlock = true;
  }
  return [out, inBlock];
}

describe('no em dashes in UI copy (AGENTS.md Frontend Conventions)', () => {
  test('client/src has no em dash outside comments', () => {
    const files = listSourceFiles(SRC_ROOT);
    const offenders = [];
    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      let inBlock = false;
      code.split('\n').forEach((line, idx) => {
        const [codeOnly, stillIn] = stripLine(line, inBlock);
        inBlock = stillIn;
        if (codeOnly.includes(EM_DASH)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `Em dashes found (replace with a hyphen, comma or colon):\n${offenders.join('\n')}`).toEqual([]);
  });
});
