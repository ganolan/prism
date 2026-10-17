import { describe, test, expect } from 'vitest';
import {
  ALERT_DEFS, alertPlan, fieldOf, fieldValuesParams, sfAlertFires, advMatchedIds, sectionAlerts, describeAlerts, dropMeta,
} from './psAlerts.js';

// Catalogue entries in the getAlertTypes.json shape (all values strings), with a
// trailing meta element as PowerSchool sends it.
const sf = (id, field, operator, operand = '', extra = {}) => ({
  id, trigger_type: 'sf', disabled: '0', name: `alert ${id}`,
  student_field: `U_Students_Extension.${field}`, ext_table_name: 'U_DEF_EXT_STUDENTS',
  student_field_operator: operator, student_field_operand: operand, ...extra,
});
const CATALOGUE = [
  sf('10593860', 'X_SPP', 'notblank'),
  sf('10593862', 'X_LS_SUPPORT_LEVEL', 'in', '1'),
  sf('10593861', 'X_LS_SUPPORT_LEVEL', 'in', '2'),
  sf('10593828', 'X_ALLERGYEPI', 'in', 'Y,1'),
  sf('39945753', 'X_HEALTHCAREPLANACTIVE', 'notblank', '', { ext_table_name: 'U_DEF_EXT_STUDENTS0', student_field: 'U_STUDENTS_EXTENSION3.X_HEALTHCAREPLANACTIVE' }),
  sf('10672509', 'X_DNC_G1', 'notblank'), // contact: stored raw, not a badge
  sf('32012479', 'X_HomeEmail', 'in', '1'), // not kept
  { id: '10593855', trigger_type: 'adv', disabled: '0', trigger_url: 'allergies.html', querystring: '' },
  { id: '11290981', trigger_type: 'adv', disabled: '0', trigger_url: 'studentsupportsummary.html', querystring: '' },
  { id: '39472338', trigger_type: 'man', disabled: '0' },
  { id: '11290939', trigger_type: 'man', disabled: '0' }, // Early Dismissal: not kept
  {},
];

describe('alertPlan', () => {
  test('keeps only the curated alerts, grouped by trigger type, each with its Prism def', () => {
    const plan = alertPlan(CATALOGUE);
    expect(plan.sf.map((t) => t.def.key)).toEqual(['accommodation_plan', 'learning_support_1', 'learning_support_2', 'epipen', 'health_care_plan']);
    expect(plan.adv.map((t) => t.def.key)).toEqual(['allergies', 'support_summary']);
    expect(plan.man.map((t) => t.def.key)).toEqual(['mobility']);
  });

  test('skips a disabled alert and survives a non-array answer', () => {
    expect(alertPlan([{ ...CATALOGUE[0], disabled: '1' }]).sf).toEqual([]);
    expect(alertPlan(null)).toEqual({ sf: [], adv: [], man: [] });
  });
});

describe('fieldValuesParams', () => {
  test('builds the plugin query: studentids, lower-case fields with their tables, then each extension table once, plus the #66 contact fields', () => {
    const plan = alertPlan(CATALOGUE);
    const p = fieldValuesParams([101, 102], plan.sf);
    expect(p.get('stuList')).toBe('101,102');
    expect(p.get('student_id')).toBe('101,102');
    const fields = [...p.entries()].filter(([k]) => /^field\d+$/.test(k)).map(([, v]) => v);
    expect(fields).toEqual(['x_spp', 'x_ls_support_level', 'x_allergyepi', 'x_healthcareplanactive', 'x_dnc_g1', 'x_dnc_g2', 'x_g1deceased', 'x_g2deceased']);
    expect(p.get('fieldTbl4')).toBe('U_DEF_EXT_STUDENTS0');
    expect(p.get('fieldTbl5')).toBe('U_DEF_EXT_STUDENTS');
    expect(p.getAll('table1')).toEqual(['U_DEF_EXT_STUDENTS']);
    expect(p.getAll('table2')).toEqual(['U_DEF_EXT_STUDENTS0']);
    expect(p.has('table3')).toBe(false);
  });

  test('a field on the students table itself gets fieldTbl "students" and no join table', () => {
    const p = fieldValuesParams([1], [{ student_field: 'Gender', ext_table_name: '' }]);
    expect(p.get('field1')).toBe('gender');
    expect(p.get('fieldTbl1')).toBe('students');
    expect(p.getAll('table1')).toEqual(['U_DEF_EXT_STUDENTS']); // the contact fields' table
  });
});

describe('sfAlertFires (the plugin rule)', () => {
  const t = (operator, operand) => ({ student_field: 'U_Students_Extension.X_F', student_field_operator: operator, student_field_operand: operand });
  test.each([
    ['notblank', '', { x_f: '1' }, true],
    ['notblank', '', { x_f: null }, false],
    ['blank', '', { x_f: null }, true],
    ['in', '1, 2', { x_f: '2' }, true],
    ['in', 'Y', { x_f: 'y' }, true],
    ['in', '1', { x_f: '3' }, false],
    ['in', ',1', { x_f: null }, true], // an empty operand item matches an empty value
    ['notin', '1,2', { x_f: '3' }, true],
    ['notin', '1,2', { x_f: '1' }, false],
    ['contains', 'abc', { x_f: 'xxABCxx' }, true],
    ['notcontain', 'abc', { x_f: 'xyz' }, true],
    ['unknown', '', { x_f: '1' }, false],
  ])('%s %j on %j → %s', (op, operand, rec, expected) => {
    expect(sfAlertFires(t(op, operand), rec)).toBe(expected);
  });
  test('fieldOf strips the table prefix and lower-cases', () => {
    expect(fieldOf('U_Students_Extension.X_SPP')).toBe('x_spp');
    expect(fieldOf('Gender')).toBe('gender');
  });
});

describe('advMatchedIds', () => {
  test('the studentid keys of the answer, without the -1 meta key', () => {
    expect([...advMatchedIds({ 101: 'x', '-1': '' })]).toEqual(['101']);
    expect(advMatchedIds([]).size).toBe(0);
    expect(advMatchedIds(null).size).toBe(0);
  });
});

describe('sectionAlerts', () => {
  const plan = alertPlan(CATALOGUE);
  const roster = [
    { ccid: '1', sectionid: '9', lastfirst: 'A', studentid: '101', studentdcid: '5001' },
    { ccid: '2', sectionid: '9', lastfirst: 'B', studentid: '102', studentdcid: '5002' },
    { ccid: '3', sectionid: '9', lastfirst: 'C', studentid: '103', studentdcid: '5003' },
    {},
  ];
  const values = [
    { id: 101, dcid: 5001, x_spp: '1', x_ls_support_level: '2', x_allergyepi: null, x_healthcareplanactive: null, x_dnc_g1: null, x_dnc_g2: '1', x_g1deceased: null, x_g2deceased: null },
    { id: 102, dcid: 5002, x_spp: null, x_ls_support_level: null, x_allergyepi: 'Y', x_healthcareplanactive: null, x_dnc_g1: null, x_dnc_g2: null, x_g1deceased: null, x_g2deceased: 1 },
    {},
  ];
  const adv = [
    { type: plan.adv[0], answer: { 102: 'Allergies', '-1': '' } },
    { type: plan.adv[1], answer: { 101: 'Summary', '-1': '' } },
  ];

  test('per student dcid: the alerts that fire (in ALERT_DEFS order) and the raw contact fields', () => {
    const out = sectionAlerts({ plan, roster, values, adv, manual: [] });
    expect([...out.keys()]).toEqual(['5001', '5002']); // 103 had no field record: not read, not listed
    expect(out.get('5001').alerts).toEqual(['accommodation_plan', 'learning_support_2', 'support_summary']);
    expect(out.get('5001').contact).toEqual({ dnc_g1: null, dnc_g2: '1', g1_deceased: null, g2_deceased: null });
    expect(out.get('5002').alerts).toEqual(['epipen', 'allergies']);
    expect(out.get('5002').contact.g2_deceased).toBe('1');
  });

  test('manual alerts attach by student dcid; expired or inactive ones do not', () => {
    const manual = [
      { u_aet_customalerts_typesid: '39472338', studentsdcid: '5002' },
      { u_aet_customalerts_typesid: '39472338', studentsdcid: '5001', expired: true },
      { u_aet_customalerts_typesid: '11290939', studentsdcid: '5001' }, // not kept
    ];
    const out = sectionAlerts({ plan, roster, values, adv: [], manual });
    expect(out.get('5002').alerts).toEqual(['epipen', 'mobility']);
    expect(out.get('5001').alerts).toEqual(['accommodation_plan', 'learning_support_2']);
  });

  test('a do-not-contact value is stored but never becomes a badge', () => {
    const out = sectionAlerts({ plan, roster, values });
    expect(out.get('5001').alerts).not.toContain('dnc_g2');
  });
});

describe('describeAlerts', () => {
  test('keys → display rows in ALERT_DEFS order; unknown keys dropped', () => {
    expect(describeAlerts(['epipen', 'gone', 'ilp'])).toEqual([
      { key: 'ilp', label: 'ILP', category: 'learning', title: 'Individual learning plan' },
      { key: 'epipen', label: 'EpiPen', category: 'health' },
    ]);
    expect(describeAlerts(null)).toEqual([]);
  });

  test('labels are short and have no em dashes', () => {
    for (const d of ALERT_DEFS) {
      expect(d.label.length).toBeLessThanOrEqual(20);
      expect(d.label).not.toMatch(/—/);
    }
  });
});

test('dropMeta drops the trailing meta element', () => {
  expect(dropMeta([{ id: 1 }, {}])).toEqual([{ id: 1 }]);
  expect(dropMeta('x')).toEqual([]);
});
