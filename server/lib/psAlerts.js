/**
 * psAlerts.js — pure helpers for PowerSchool's student alerts (#117): which
 * alerts fire for a student, read from the MBA custom-alerts plugin the teacher
 * sees as icons beside each name in PowerSchool's attendance page.
 *
 * The plugin's catalogue (getAlertTypes.json) lists every configured alert with
 * a trigger type:
 *   sf  — a student-field rule (field, operator, operand), evaluated here on the
 *         values stuFieldValues.json returns, the same way the plugin does;
 *   adv — an advanced query: getAdvTriggerMatches.html answers with an object
 *         keyed by the PowerSchool studentid of each student it matches;
 *   man — a manual alert: getAlerts.json rows (per the plugin's code).
 * See .claude/powerschool-api-reference.md "Student alerts (#117)".
 *
 * Prism keeps a short, curated set (ALERT_DEFS), keyed by the catalogue id, with
 * its own neutral labels. Contact alerts (do not contact, deceased guardian) are
 * stored as raw field values for #66 and never shown as badges.
 */

// Category drives the badge colour: learning support, health, other.
export const ALERT_DEFS = [
  { key: 'accommodation_plan', label: 'Accommodation plan', category: 'learning', psAlertIds: ['10593860'] },
  { key: 'accommodations_only', label: 'Accommodations only', category: 'learning', psAlertIds: ['11361904'] },
  { key: 'ilp', label: 'ILP', category: 'learning', psAlertIds: ['10593859'], title: 'Individual learning plan' },
  { key: 'learning_support_1', label: 'Learning support 1', category: 'learning', psAlertIds: ['10593862'] },
  { key: 'learning_support_2', label: 'Learning support 2', category: 'learning', psAlertIds: ['10593861'] },
  { key: 'learning_support_3', label: 'Learning support 3', category: 'learning', psAlertIds: ['10593863'] },
  { key: 'support_summary', label: 'Support summary', category: 'learning', psAlertIds: ['11290981'] },
  { key: 'epipen', label: 'EpiPen', category: 'health', psAlertIds: ['10593828'] },
  { key: 'allergies', label: 'Allergies', category: 'health', psAlertIds: ['10593855'] },
  { key: 'health_care_plan', label: 'Health care plan', category: 'health', psAlertIds: ['39945753'] },
  { key: 'mobility', label: 'Mobility', category: 'other', psAlertIds: ['39472338'] },
  { key: 'elevator', label: 'Elevator', category: 'other', psAlertIds: ['10672527'] },
  { key: 'no_photo', label: 'No photo', category: 'other', psAlertIds: ['10593856'] },
];

const DEF_BY_KEY = new Map(ALERT_DEFS.map((d) => [d.key, d]));
const DEF_BY_PS_ID = new Map(ALERT_DEFS.flatMap((d) => d.psAlertIds.map((id) => [id, d])));

// Guardian-contact fields #66 decides how to show: stored raw, as PowerSchool
// returns them (null = not set). column = student_powerschool column.
export const CONTACT_FIELDS = [
  { field: 'x_dnc_g1', column: 'dnc_g1' },
  { field: 'x_dnc_g2', column: 'dnc_g2' },
  { field: 'x_g1deceased', column: 'g1_deceased' },
  { field: 'x_g2deceased', column: 'g2_deceased' },
];
const CONTACT_TABLE = 'U_DEF_EXT_STUDENTS';

// The plugin's getData pops a trailing meta element off every array answer.
export function dropMeta(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r && typeof r === 'object' && r.id != null);
}

// Catalogue entries (getAlertTypes.json) Prism reads, grouped by trigger type.
// Each entry carries its Prism def. Entries Prism does not keep are skipped.
export function alertPlan(catalogue) {
  const plan = { sf: [], adv: [], man: [] };
  for (const t of dropMeta(catalogue)) {
    const def = DEF_BY_PS_ID.get(String(t.id));
    if (!def || String(t.disabled) === '1') continue;
    if (plan[t.trigger_type]) plan[t.trigger_type].push({ ...t, def });
  }
  return plan;
}

// The field part of a catalogue student_field ("U_Students_Extension.X_SPP" →
// "x_spp"); stuFieldValues answers with lower-case keys.
export const fieldOf = (studentField) => {
  const s = String(studentField || '');
  return (s.includes('.') ? s.split('.')[1] : s).toLowerCase();
};

// stuFieldValues.json query for a list of PowerSchool studentids, built the way
// the plugin builds it: field{n} (lower case) + fieldTbl{n} per field, then
// table{n} per distinct extension table. Adds the #66 contact fields.
export function fieldValuesParams(studentIds, sfTypes) {
  const list = studentIds.map(String).join(',');
  const params = new URLSearchParams({ stuList: list, student_id: list });
  const fields = new Map(); // field → table
  for (const t of sfTypes) {
    const sf = String(t.student_field || '');
    const table = sf.includes('.') ? t.ext_table_name : 'students';
    fields.set(fieldOf(sf), table);
  }
  for (const { field } of CONTACT_FIELDS) if (!fields.has(field)) fields.set(field, CONTACT_TABLE);
  let n = 0;
  for (const [field, table] of fields) {
    n++;
    params.append(`field${n}`, field);
    params.append(`fieldTbl${n}`, table);
  }
  [...new Set([...fields.values()].filter((t) => t !== 'students'))]
    .forEach((table, i) => params.append(`table${i + 1}`, table));
  return params;
}

// Does an sf alert fire for one stuFieldValues record? The plugin's own rule
// (operators notblank, blank, in, notin, contains, notcontain; operand is a
// comma list, case-insensitive, where an empty item matches an empty value).
export function sfAlertFires(type, record) {
  const fld = fieldOf(type.student_field);
  const raw = record?.[fld];
  const BLANK = '\u0000blank';
  let value = raw == null ? '' : String(raw).toLowerCase();
  const operand = type.student_field_operand
    ? String(type.student_field_operand).split(',').map((e) => (e.trim() === '' ? BLANK : e.trim().toLowerCase()))
    : [];
  if (operand.includes(BLANK) && value === '') value = BLANK;
  switch (type.student_field_operator) {
    case 'notblank': return raw != null;
    case 'blank': return raw == null;
    case 'notin': return !operand.includes(value);
    case 'in': return operand.includes(value);
    case 'contains': return operand.length > 0 && value.includes(operand[0]);
    case 'notcontain': return operand.length > 0 && !value.includes(operand[0]);
    default: return false;
  }
}

// Studentids an advanced query matched: its answer is an object keyed by
// studentid, plus a "-1" meta key.
export function advMatchedIds(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return new Set();
  return new Set(Object.keys(answer).filter((k) => k !== '-1'));
}

/**
 * One section's alerts, per student. → Map<studentDcid, { alerts: string[] (Prism
 * keys, ALERT_DEFS order), contact: { dnc_g1, dnc_g2, g1_deceased, g2_deceased } }>.
 *
 * roster: [{ studentid, studentdcid }] (getStudentsInSection.json)
 * values: stuFieldValues.json records [{ id (studentid), dcid, <field>: value }]
 * adv:    [{ type, answer }] per advanced alert read
 * manual: getAlerts.json rows [{ u_aet_customalerts_typesid, studentsdcid, expired, inactive }]
 * A student appears only when the field read returned a record for them.
 */
export function sectionAlerts({ plan, roster, values, adv = [], manual = [] }) {
  const dcidByStudentId = new Map((Array.isArray(roster) ? roster : [])
    .filter((r) => r && r.studentid != null && r.studentdcid != null)
    .map((r) => [String(r.studentid), String(r.studentdcid)]));
  const out = new Map();
  for (const rec of dropMeta(values)) {
    const dcid = String(dcidByStudentId.get(String(rec.id)) ?? rec.dcid ?? '');
    if (!dcid) continue;
    const keys = new Set();
    for (const t of plan.sf) if (sfAlertFires(t, rec)) keys.add(t.def.key);
    for (const { type, answer } of adv) if (advMatchedIds(answer).has(String(rec.id))) keys.add(type.def.key);
    const contact = {};
    for (const { field, column } of CONTACT_FIELDS) contact[column] = rec[field] == null ? null : String(rec[field]);
    out.set(dcid, { studentId: String(rec.id), alerts: keys, contact });
  }
  const manDefs = new Map(plan.man.map((t) => [String(t.id), t.def]));
  for (const row of Array.isArray(manual) ? manual : []) {
    if (!row || row.expired || row.inactive) continue;
    const def = manDefs.get(String(row.u_aet_customalerts_typesid));
    const entry = out.get(String(row.studentsdcid));
    if (def && entry) entry.alerts.add(def.key);
  }
  for (const entry of out.values()) entry.alerts = ALERT_DEFS.map((d) => d.key).filter((k) => entry.alerts.has(k));
  return out;
}

// Stored keys → display shape [{ key, label, category, title? }], in ALERT_DEFS
// order; unknown keys are dropped.
export function describeAlerts(keys) {
  const set = new Set(keys || []);
  return ALERT_DEFS.filter((d) => set.has(d.key)).map(({ key, label, category, title }) => ({
    key, label, category, ...(title ? { title } : {}),
  }));
}

export const alertDef = (key) => DEF_BY_KEY.get(key) || null;
