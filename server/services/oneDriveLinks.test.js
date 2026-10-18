import { describe, test, expect, beforeEach, vi } from 'vitest';
import { oneDriveDeps, getAssignmentFiles, getAssignmentFilesMany, clearOneDriveCache } from './oneDriveLinks.js';

// A fake SharePoint session: records each listing, answers from `folders`.
function fakeSession(folders) {
  const session = {
    status: 'ok', origin: 'https://sp.example',
    listFiles: vi.fn(async (sectionId, assignmentId) => folders[`${sectionId}:${assignmentId}`] ?? { status: 'no_folder' }),
    close: vi.fn(async () => {}),
  };
  return session;
}

const real = { ...oneDriveDeps };
beforeEach(() => {
  clearOneDriveCache();
  Object.assign(oneDriveDeps, real);
});

describe('getAssignmentFilesMany (student page, #135)', () => {
  test('lists several assignments in one browser session', async () => {
    const session = fakeSession({
      's1:a1': { status: 'ok', origin: 'https://sp.example', files: [{ Name: 'x' }] },
      's1:a2': { status: 'ok', origin: 'https://sp.example', files: [] },
    });
    oneDriveDeps.openSession = vi.fn(async () => session);
    const out = await getAssignmentFilesMany([{ sectionId: 's1', assignmentId: 'a1' }, { sectionId: 's1', assignmentId: 'a2' }, { sectionId: 's1', assignmentId: 'a3' }]);
    expect(oneDriveDeps.openSession).toHaveBeenCalledTimes(1);
    expect(session.listFiles).toHaveBeenCalledTimes(3);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(out.get('s1:a1')).toMatchObject({ status: 'ok', files: [{ Name: 'x' }] });
    expect(out.get('s1:a3')).toEqual({ status: 'no_folder' });
  });

  test('cached listings are not listed again, and need no browser', async () => {
    const session = fakeSession({ 's1:a1': { status: 'ok', origin: 'o', files: [] } });
    oneDriveDeps.openSession = vi.fn(async () => session);
    await getAssignmentFiles({ sectionId: 's1', assignmentId: 'a1' });
    const out = await getAssignmentFilesMany([{ sectionId: 's1', assignmentId: 'a1' }]);
    expect(out.get('s1:a1').status).toBe('ok');
    expect(oneDriveDeps.openSession).toHaveBeenCalledTimes(1);
    expect(session.listFiles).toHaveBeenCalledTimes(1);
  });

  test('a session that cannot sign in gives every assignment its status, and nothing is cached', async () => {
    oneDriveDeps.openSession = vi.fn(async () => ({ status: 'sso_failed' }));
    const out = await getAssignmentFilesMany([{ sectionId: 's1', assignmentId: 'a1' }, { sectionId: 's1', assignmentId: 'a2' }]);
    expect([...out.values()]).toEqual([{ status: 'sso_failed' }, { status: 'sso_failed' }]);
    await getAssignmentFilesMany([{ sectionId: 's1', assignmentId: 'a1' }]);
    expect(oneDriveDeps.openSession).toHaveBeenCalledTimes(2);
  });

  test('a listing that throws becomes an error for that assignment only', async () => {
    const session = fakeSession({ 's1:a2': { status: 'ok', origin: 'o', files: [] } });
    session.listFiles.mockImplementationOnce(async () => { throw new Error('boom'); });
    oneDriveDeps.openSession = vi.fn(async () => session);
    const out = await getAssignmentFilesMany([{ sectionId: 's1', assignmentId: 'a1' }, { sectionId: 's1', assignmentId: 'a2' }]);
    expect(out.get('s1:a1')).toEqual({ status: 'error' });
    expect(out.get('s1:a2').status).toBe('ok');
  });
});
