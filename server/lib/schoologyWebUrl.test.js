import { describe, test, expect } from 'vitest';
import { toSchoologyWebUrl } from './schoologyWebUrl.js';

const BASE = 'https://schoology.hkis.edu.hk';

describe('toSchoologyWebUrl', () => {
  test('rewrites the generic app.schoology.com host to the school domain, keeping the path', () => {
    expect(toSchoologyWebUrl('https://app.schoology.com/assignments/7947070743/info', BASE))
      .toBe('https://schoology.hkis.edu.hk/assignments/7947070743/info');
  });

  test('preserves the alternate /assignment/{id} path shape Schoology also returns', () => {
    expect(toSchoologyWebUrl('https://app.schoology.com/assignment/7947070792', BASE))
      .toBe('https://schoology.hkis.edu.hk/assignment/7947070792');
  });

  test('preserves query string and hash', () => {
    expect(toSchoologyWebUrl('https://app.schoology.com/assignment/1?x=2#frag', BASE))
      .toBe('https://schoology.hkis.edu.hk/assignment/1?x=2#frag');
  });

  test('is idempotent for a url already on the school domain', () => {
    expect(toSchoologyWebUrl('https://schoology.hkis.edu.hk/assignments/1/info', BASE))
      .toBe('https://schoology.hkis.edu.hk/assignments/1/info');
  });

  test('tolerates a base with a trailing slash', () => {
    expect(toSchoologyWebUrl('https://app.schoology.com/assignment/1', 'https://schoology.hkis.edu.hk/'))
      .toBe('https://schoology.hkis.edu.hk/assignment/1');
  });

  test('returns null for a falsy url', () => {
    expect(toSchoologyWebUrl(null, BASE)).toBeNull();
    expect(toSchoologyWebUrl('', BASE)).toBeNull();
    expect(toSchoologyWebUrl(undefined, BASE)).toBeNull();
  });

  test('returns null for an unparseable url', () => {
    expect(toSchoologyWebUrl('not a url', BASE)).toBeNull();
  });

  test('returns the original url unchanged when no base is configured', () => {
    expect(toSchoologyWebUrl('https://app.schoology.com/assignment/1', null))
      .toBe('https://app.schoology.com/assignment/1');
  });
});
