import fs from 'fs';
import path from 'path';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

// Shared by server/copy.test.js and mcp/copy.test.js: the "no em dashes in
// user-facing copy" guard (AGENTS.md Frontend Conventions).
//
// Uses a real parser rather than a hand-rolled comment/string stripper: plain
// server/mcp JS has genuine regex literals with quote characters inside
// character classes (e.g. server/routes/tools.js: /[(),<>@;:"\[\]]/), which
// trick a naive tokenizer into treating the quote as a string opening and
// desyncing for the rest of the file (a comment's apostrophe can do the same
// to a quoted-string regex). An AST walk tells a RegExpLiteral, a comment and
// a real StringLiteral/TemplateElement apart for free.
const traverse = traverseModule.default || traverseModule;

export const EM_DASH = String.fromCharCode(0x2014);

export function listJsFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'testing') continue;
      listJsFiles(full, files);
    } else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
      files.push(full);
    }
  }
  return files;
}

// `allowlist` entries are `{ file, text }` pairs: `file` is a path suffix
// (e.g. 'server/routes/mastery.js') and `text` a substring of the exact
// offending string/template content. Both must match, so an allowlist entry
// can only exempt the one known console-only line it documents, not every
// future em dash with similar wording anywhere in the tree.
//
// Returns `${relPath}:${line}: ${snippet}` entries for every remaining
// string/template literal containing an em dash (console-only diagnostics,
// never shown to a teacher or agent, are exempt from the UI-copy rule via
// the allowlist above).
export function findEmDashOffenders(rootDir, { allowlist = [] } = {}) {
  const offenders = [];
  for (const file of listJsFiles(rootDir)) {
    const code = fs.readFileSync(file, 'utf8');
    if (!code.includes(EM_DASH)) continue;
    const relFile = path.relative(process.cwd(), file);
    const ast = parse(code, { sourceType: 'module', errorRecovery: true });
    const hits = [];
    traverse(ast, {
      StringLiteral(p) {
        if (p.node.value.includes(EM_DASH)) hits.push({ line: p.node.loc.start.line, text: p.node.value });
      },
      TemplateElement(p) {
        if (p.node.value.raw.includes(EM_DASH)) hits.push({ line: p.node.loc.start.line, text: p.node.value.raw });
      },
    });
    for (const { line, text } of hits) {
      const allowed = allowlist.some((rule) => relFile.endsWith(rule.file) && text.includes(rule.text));
      if (allowed) continue;
      offenders.push(`${relFile}:${line}: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`);
    }
  }
  return offenders;
}
