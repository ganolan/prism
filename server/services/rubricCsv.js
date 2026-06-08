import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

// Column header (normalized) → level code. Exact match so "Exhibiting" never
// captures "Exhibiting Depth".
const HEADER_LEVEL = {
  'exhibiting depth': 'ED',
  'exhibiting': 'EX',
  'developing': 'D',
  'emerging': 'EM',
  'insufficient evidence': 'IE',
};
const TEMPLATE_HEADERS = [
  'Criteria', 'Reporting Category', 'Standard',
  'Exhibiting Depth', 'Exhibiting', 'Developing', 'Emerging', 'Insufficient Evidence',
];
const norm = (s) => (s || '').trim().toLowerCase();
const pick = (row, ...names) => {
  for (const n of names) {
    const hit = Object.keys(row).find(k => norm(k) === norm(n));
    if (hit && row[hit] != null && row[hit] !== '') return row[hit];
  }
  return '';
};

export function parseRubricCsv(content, { name }) {
  const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });
  const criteria = rows.map((row, i) => {
    const descriptors = {};
    for (const [header, value] of Object.entries(row)) {
      const lvl = HEADER_LEVEL[norm(header)];
      if (lvl) descriptors[lvl] = value || '';
    }
    if (!descriptors.IE) descriptors.IE = 'Insufficient Evidence';
    return {
      position: i + 1,
      criterion_name: pick(row, 'Criteria', 'Criterion') || null,
      standard_title: pick(row, 'Standard', 'Anchor Standard (Measurement Topic)', 'Measurement Topic') || null,
      reporting_category: pick(row, 'Reporting Category') || null,
      external_id: pick(row, 'External ID', 'External_ID') || null,
      descriptors,
    };
  });
  return { name, source: 'csv', criteria };
}

export function templateCsv() {
  const example = {
    Criteria: 'UI/UX', 'Reporting Category': 'Produce',
    Standard: 'Anchor Standard 4: Select, analyze, and interpret artistic work for presentation',
    'Exhibiting Depth': 'Polished, cohesive, intentional.', Exhibiting: 'Clear and consistent.',
    Developing: 'Partly usable but inconsistent.', Emerging: 'Lacks clarity or structure.',
    'Insufficient Evidence': 'Insufficient Evidence',
  };
  return stringify([example], { header: true, columns: TEMPLATE_HEADERS });
}

export function exportRubricCsv(content) {
  const records = content.criteria.map(c => ({
    Criteria: c.criterion_name || '', 'Reporting Category': c.reporting_category || '',
    Standard: c.standard_title || '',
    'Exhibiting Depth': c.descriptors?.ED || '', Exhibiting: c.descriptors?.EX || '',
    Developing: c.descriptors?.D || '', Emerging: c.descriptors?.EM || '',
    'Insufficient Evidence': c.descriptors?.IE || 'Insufficient Evidence',
  }));
  return stringify(records, { header: true, columns: TEMPLATE_HEADERS });
}
