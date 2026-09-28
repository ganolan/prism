import { describe, test, expect } from 'vitest';
import {
  findFolderById,
  parseSubmissionFileName,
  fileOpenUrl,
  matchFilesToRoster,
} from './oneDriveSubmissions.js';

const ORIGIN = 'https://hkis-my.sharepoint.com';
const DIR = '/personal/t_school_edu/Documents/Schoology Microsoft OneDrive Assignments/AI  MACHINE LEARNING 1(A-B) - 8458134359/Launch - Development (S) - 8555933030';

function file(name, extra = {}) {
  return {
    Name: name,
    ServerRelativeUrl: `${DIR}/${name}`,
    LinkingUrl: `${ORIGIN}${DIR}/${name}?d=w0123456789abcdef0123456789abcdef`,
    UniqueId: '6c2a49bf-4fe6-41c3-8a9e-79f6c3f04694',
    TimeLastModified: '2026-09-28T06:27:25Z',
    ...extra,
  };
}

describe('findFolderById', () => {
  const folders = [
    { Name: 'ROBOTICS 5(A-B) - 8458134338', ServerRelativeUrl: '/a' },
    { Name: 'AI  MACHINE LEARNING 1(A-B) - 8458134359', ServerRelativeUrl: '/b' },
  ];

  test('matches on the " - {id}" suffix, not the (sanitised) title', () => {
    expect(findFolderById(folders, '8458134359')).toEqual(folders[1]);
  });

  test('does not match an id that is only a suffix of a longer id', () => {
    expect(findFolderById([{ Name: 'X - 18458134359' }], '8458134359')).toBeNull();
  });

  test('null when absent or folders missing', () => {
    expect(findFolderById(folders, '1')).toBeNull();
    expect(findFolderById(null, '1')).toBeNull();
  });
});

describe('parseSubmissionFileName', () => {
  test('splits the student name on the FIRST " - " (titles contain " - " too)', () => {
    expect(parseSubmissionFileName('Alison Cheng - AIML Project - Useless Product Launch - Development (S) - 4299333.pptx'))
      .toEqual({ studentName: 'Alison Cheng', fileNumber: '4299333' });
  });

  test('null for names that are not student copies', () => {
    expect(parseSubmissionFileName('Template.pptx')).toBeNull();
    expect(parseSubmissionFileName('Alison Cheng - no number.pptx')).toBeNull();
  });
});

describe('fileOpenUrl', () => {
  test('prefers SharePoint\'s own LinkingUrl (redirects to the Doc.aspx editor)', () => {
    const f = file('A B - T - 1.pptx');
    expect(fileOpenUrl(f, ORIGIN)).toBe(f.LinkingUrl);
  });

  test('falls back to the encoded file URL when LinkingUrl is empty (non-Office files)', () => {
    const f = file('A B - T - 1.pdf', { LinkingUrl: '' });
    expect(fileOpenUrl(f, ORIGIN)).toBe(`${ORIGIN}${encodeURI(`${DIR}/A B - T - 1.pdf`)}`);
  });
});

describe('matchFilesToRoster', () => {
  const roster = [
    { schoology_uid: '13574158', first_name: 'Alison', last_name: 'Cheng', preferred_name: null },
    { schoology_uid: '132465405', first_name: 'Garmin', last_name: 'Ho', preferred_name: null },
    { schoology_uid: '555', first_name: 'Yongzhen', last_name: 'Cheng', preferred_name: 'Peter' },
  ];

  test('keys each file to the student whose name leads the filename', () => {
    const links = matchFilesToRoster([
      file('Alison Cheng - Launch - Development (S) - 4299333.pptx'),
      file('Garmin Ho - Launch - Development (S) - 4414330.pptx', { TimeLastModified: '2026-09-28T06:14:52Z' }),
    ], roster, ORIGIN);
    expect(Object.keys(links).sort()).toEqual(['132465405', '13574158']);
    expect(links['13574158']).toEqual({
      url: `${ORIGIN}${DIR}/Alison Cheng - Launch - Development (S) - 4299333.pptx?d=w0123456789abcdef0123456789abcdef`,
      fileName: 'Alison Cheng - Launch - Development (S) - 4299333.pptx',
      modifiedAt: '2026-09-28T06:27:25Z',
    });
  });

  test('matching is case/whitespace-insensitive and accepts the preferred first name', () => {
    const links = matchFilesToRoster([file('peter  CHENG - T - 1.pptx')], roster, ORIGIN);
    expect(Object.keys(links)).toEqual(['555']);
  });

  test('unmatched files are ignored (never guessed onto a student)', () => {
    expect(matchFilesToRoster([file('Someone Else - T - 1.pptx')], roster, ORIGIN)).toEqual({});
  });

  test('a name shared by two students links neither — never open the wrong student\'s work', () => {
    const twins = [...roster, { schoology_uid: '999', first_name: 'Garmin', last_name: 'Ho', preferred_name: null }];
    expect(matchFilesToRoster([file('Garmin Ho - T - 1.pptx')], twins, ORIGIN)).toEqual({});
  });

  test('several files for one student → the most recently modified wins', () => {
    const links = matchFilesToRoster([
      file('Alison Cheng - T - 1.pptx', { TimeLastModified: '2026-09-01T00:00:00Z' }),
      file('Alison Cheng - T - 2.pptx', { TimeLastModified: '2026-09-20T00:00:00Z' }),
      file('Alison Cheng - T - 3.pptx', { TimeLastModified: '2026-09-10T00:00:00Z' }),
    ], roster, ORIGIN);
    expect(links['13574158'].fileName).toBe('Alison Cheng - T - 2.pptx');
  });
});
