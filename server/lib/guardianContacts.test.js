import { describe, test, expect } from 'vitest';
import { CONTACT_REASONS, placeParents, statusFor } from './guardianContacts.js';

// Masked fixtures: invented names and example.test addresses only.
const parent = (id, first_name, last_name, email = null) => ({ id, first_name, last_name, email });

describe('placeParents', () => {
  test('places by email to exactly one slot', () => {
    const slots = { 1: { name: 'Sample, Robin', email: 'robin@example.test' }, 2: { name: 'Sample, Kit', email: 'kit@example.test' } };
    const placed = placeParents([parent(10, 'Someone', 'Else', '  KIT@Example.TEST '), parent(11, 'Robin', 'Sample', 'robin@example.test')], slots);
    expect(placed.get(10)).toBe(2);
    expect(placed.get(11)).toBe(1);
  });

  test('the same email in both slots falls back to the name', () => {
    const slots = { 1: { name: 'Sample, Robin', email: 'family@example.test' }, 2: { name: 'Sample, Kit', email: 'family@example.test' } };
    const placed = placeParents([parent(10, 'Kit', 'Sample', 'family@example.test'), parent(11, 'Jo', 'Other', 'family@example.test')], slots);
    expect(placed.get(10)).toBe(2);
    expect(placed.get(11)).toBeNull();
  });

  test('places by surname plus a first-name word when the email differs', () => {
    const slots = { 1: { name: 'Van Tester, Robin Alex', email: 'r@example.test' }, 2: { name: 'Sample, Kit', email: 'k@example.test' } };
    const placed = placeParents([parent(10, 'Alex', 'van Tester', 'other@example.test'), parent(11, 'Kit Lee', 'Sample', null)], slots);
    expect(placed.get(10)).toBe(1);
    expect(placed.get(11)).toBe(2);
    // Every surname word must be before the comma; a first-name word alone is not enough.
    expect(placeParents([parent(12, 'Robin', 'Tester-Jones')], slots).get(12)).toBeNull();
    expect(placeParents([parent(13, 'Robin', 'Robin')], { 1: { name: 'Tester, Robin' } }).get(13)).toBeNull();
  });

  test('surname alone is not enough when both slots share it', () => {
    const slots = { 1: { name: 'Sample, Robin', email: 'r@example.test' }, 2: { name: 'Sample, Kit', email: 'k@example.test' } };
    const placed = placeParents([parent(10, 'Jordan', 'Sample', 'j@example.test'), parent(11, 'Robin Kit', 'Sample', null)], slots);
    expect(placed.get(10)).toBeNull();
    expect(placed.get(11)).toBeNull(); // a first-name word in both slots: ambiguous
  });

  test('a slot taken by email is closed to a name match', () => {
    const slots = { 1: { name: 'Sample, Robin', email: 'r@example.test' }, 2: { name: 'Other, Kit', email: 'k@example.test' } };
    const placed = placeParents([parent(10, 'Someone', 'Else', 'r@example.test'), parent(11, 'Robin', 'Sample', 'x@example.test')], slots);
    expect(placed.get(10)).toBe(1);
    expect(placed.get(11)).toBeNull();
  });

  test('two name matches on one slot place neither', () => {
    const slots = { 1: { name: 'Sample, Robin', email: 'r@example.test' }, 2: { name: 'Other, Kit', email: 'k@example.test' } };
    const placed = placeParents([parent(10, 'Robin', 'Sample', null), parent(11, 'Robin', 'Sample', 'y@example.test'), parent(12, 'Kit', 'Other', null)], slots);
    expect(placed.get(10)).toBeNull();
    expect(placed.get(11)).toBeNull();
    expect(placed.get(12)).toBe(2);
  });

  test('no slots, or a parent with no name or email, places nothing', () => {
    expect(placeParents([parent(10, 'Robin', 'Sample', 'r@example.test')], {}).get(10)).toBeNull();
    expect(placeParents([parent(11, '', '', '')], { 1: { name: ', ', email: '' } }).get(11)).toBeNull();
  });
});

describe('statusFor', () => {
  const none = { dnc_g1: null, dnc_g2: null, g1_deceased: null, g2_deceased: null };

  test('statusFor follows the table order', () => {
    // not_checked: no successful guardian read, whatever else is set.
    expect(statusFor({ checked: false, slot: 1, flags: { ...none, dnc_g1: '1' }, correspondence: '1' })).toEqual({ status: 'not_checked', primary: false });
    // not_matched: checked but not placed.
    expect(statusFor({ checked: true, slot: null, flags: { ...none, dnc_g1: '1' }, correspondence: '1' })).toEqual({ status: 'not_matched', primary: false });
    // do_not_contact: any value, wider than the catalogue's `in 1` (fail safe).
    expect(statusFor({ checked: true, slot: 1, flags: { ...none, dnc_g1: '1' }, correspondence: '1' }).status).toBe('do_not_contact');
    expect(statusFor({ checked: true, slot: 2, flags: { ...none, dnc_g2: 'Y' }, correspondence: null }).status).toBe('do_not_contact');
    // do_not_contact comes before deceased.
    expect(statusFor({ checked: true, slot: 1, flags: { ...none, dnc_g1: '1', g1_deceased: '1' }, correspondence: null }).status).toBe('do_not_contact');
    // deceased: any value, including '0'.
    expect(statusFor({ checked: true, slot: 1, flags: { ...none, g1_deceased: '0' }, correspondence: null })).toEqual({ status: 'deceased', primary: false });
    // contactable: the other slot's flags do not apply; '' is not set.
    expect(statusFor({ checked: true, slot: 1, flags: { dnc_g1: '', dnc_g2: '1', g1_deceased: '', g2_deceased: '1' }, correspondence: null })).toEqual({ status: 'contactable', primary: false });
  });

  test('primary only for code 1 or 2 on the matching slot', () => {
    const at = (slot, correspondence) => statusFor({ checked: true, slot, flags: none, correspondence }).primary;
    expect(at(1, '1')).toBe(true);
    expect(at(2, ' 2 ')).toBe(true);
    expect(at(1, '2')).toBe(false);
    expect(at(1, '3')).toBe(false);
    expect(at(2, '3')).toBe(false);
    expect(at(1, null)).toBe(false);
  });

  test('every status but contactable has a reason', () => {
    expect(CONTACT_REASONS).toEqual({
      do_not_contact: 'Do not contact (PowerSchool)',
      deceased: 'Deceased (PowerSchool)',
      not_matched: 'Not matched to a PowerSchool guardian',
      not_checked: 'Not checked against PowerSchool yet',
    });
  });
});
