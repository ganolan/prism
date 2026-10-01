// Parse a Master Plan workbook's "Daily Planning View" for the calendar parity
// check (scripts/parity-school-calendar.js). An .xlsx is a zip of XML: read it
// with the system `unzip` (no new dependency) and parse this flat sheet with
// regexes. Column E = date (Excel serial), F = cycle day 1–8 on school days
// (text like 'SAT' or blank otherwise).
import { execFileSync } from 'child_process';

export function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((m) => decodeXml([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
}

export function parseSheetRows(xml, shared) {
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const col = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] || '')?.[1];
      if (!col || v === undefined) continue;
      cells[col] = /\bt="s"/.test(attrs) ? shared[Number(v)] : decodeXml(v);
    }
    rows.push(cells);
  }
  return rows;
}

export function excelSerialToIso(serial) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(Number(serial)) * 86400000).toISOString().slice(0, 10);
}

export function planDays(rows) {
  return rows
    .filter((r) => r.E && /^\d+(\.\d+)?$/.test(r.E))
    .map((r) => {
      const f = String(r.F ?? '').trim();
      return { date: excelSerialToIso(r.E), cycleDay: /^\d+$/.test(f) ? Number(f) : null };
    });
}

// Compare stored PowerSchool rows with the plan over the dates both cover.
export function compareCalendars(psRows, plan) {
  const ps = new Map(psRows.map((r) => [r.date, r]));
  const psDates = psRows.map((r) => r.date).sort();
  const planDates = plan.map((p) => p.date).sort();
  const from = psDates[0] > planDates[0] ? psDates[0] : planDates[0];
  const to = psDates.at(-1) < planDates.at(-1) ? psDates.at(-1) : planDates.at(-1);
  const inRange = (d) => d >= from && d <= to;

  const onlyInPs = [];
  const onlyInPlan = [];
  const letterByParity = {};
  const letterMismatches = [];
  const planDatesSet = new Set(planDates);
  let planSchoolDays = 0;

  for (const p of plan) {
    if (!inRange(p.date)) continue;
    const row = ps.get(p.date);
    const planSchool = p.cycleDay != null;
    const psSchool = !!row?.in_session;
    if (planSchool) planSchoolDays++;
    if (planSchool && !psSchool) onlyInPlan.push(p.date);
    if (!planSchool && psSchool) onlyInPs.push(p.date);
    if (planSchool && psSchool && row.cycle_letter) {
      const parity = p.cycleDay % 2;
      if (!(parity in letterByParity)) letterByParity[parity] = row.cycle_letter;
      else if (letterByParity[parity] !== row.cycle_letter) letterMismatches.push({ date: p.date, cycleDay: p.cycleDay, letter: row.cycle_letter });
    }
  }
  for (const r of psRows) {
    if (inRange(r.date) && r.in_session && !planDatesSet.has(r.date)) onlyInPs.push(r.date);
  }
  const psSchoolDays = psRows.filter((r) => inRange(r.date) && r.in_session).length;
  return { overlap: { from, to }, planSchoolDays, psSchoolDays, onlyInPs: onlyInPs.sort(), onlyInPlan, letterByParity, letterMismatches };
}

export function readSheetFromXlsx(file, nameFragment) {
  const unzip = (p) => execFileSync('unzip', ['-p', file, p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const wb = unzip('xl/workbook.xml');
  const sheet = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0])
    .find((tag) => decodeXml(/name="([^"]*)"/.exec(tag)?.[1] || '').includes(nameFragment));
  if (!sheet) throw new Error(`No sheet whose name contains "${nameFragment}"`);
  const rid = /r:id="([^"]+)"/.exec(sheet)[1];
  const rel = [...unzip('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0])
    .find((tag) => tag.includes(`Id="${rid}"`));
  const target = /Target="([^"]+)"/.exec(rel)[1];
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  let shared = [];
  try { shared = parseSharedStrings(unzip('xl/sharedStrings.xml')); } catch { /* no shared strings */ }
  return parseSheetRows(unzip(path), shared);
}
