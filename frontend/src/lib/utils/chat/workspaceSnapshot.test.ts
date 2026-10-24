// @vitest-environment happy-dom
/**
 * The saved community list is a copy of a listing, owned by ONE account, and refused whole when it
 * is not exactly what this module wrote (community-open-budget F1).
 */
import {
  clearWorkspaceSnapshots,
  readWorkspaceSnapshot,
  serializeWorkspaceSnapshot,
  storeWorkspaceSnapshot,
} from './workspaceSnapshot';

const KEY = (id: string) => `canari_workspace_snapshot:v1:${id}`;

beforeEach(() => localStorage.clear());

describe('workspaceSnapshot', () => {
  it('round-trips a listed community and drops a row with no server id', () => {
    const text = serializeWorkspaceSnapshot('u1', [
      {
        id: 'one',
        name: 'One',
        workspaceDbId: 'ws1',
        avatarUserId: 'One',
        imageMediaId: null,
        channels: [{ id: 'channel_c1', name: 'general', unreadCount: 4 } as never],
      },
      { id: 'local', name: 'Local', avatarUserId: 'L', channels: [] },
    ]);
    storeWorkspaceSnapshot('u1', text);
    const read = readWorkspaceSnapshot('u1');
    expect(read!.map((w) => w.id)).toEqual(['one']);
    expect(read![0].channels[0]).not.toHaveProperty('unreadCount');
  });

  it('refuses and deletes a slot whose owner is not the account asking', () => {
    localStorage.setItem(KEY('u2'), serializeWorkspaceSnapshot('u1', []));
    expect(readWorkspaceSnapshot('u2')).toBeNull();
    expect(localStorage.getItem(KEY('u2'))).toBeNull();
  });

  it('refuses and deletes a slot that is not a snapshot', () => {
    localStorage.setItem(KEY('u1'), '{"owner":"u1","workspaces":[{"id":3}]}');
    expect(readWorkspaceSnapshot('u1')).toBeNull();
    expect(localStorage.getItem(KEY('u1'))).toBeNull();
    localStorage.setItem(KEY('u1'), 'not json');
    expect(readWorkspaceSnapshot('u1')).toBeNull();
    expect(localStorage.getItem(KEY('u1'))).toBeNull();
  });

  it('clears every account slot and nothing else', () => {
    storeWorkspaceSnapshot('u1', serializeWorkspaceSnapshot('u1', []));
    storeWorkspaceSnapshot('u2', serializeWorkspaceSnapshot('u2', []));
    localStorage.setItem('canari_other', 'kept');
    expect(clearWorkspaceSnapshots()).toBe(2);
    expect(localStorage.getItem(KEY('u1'))).toBeNull();
    expect(localStorage.getItem(KEY('u2'))).toBeNull();
    expect(localStorage.getItem('canari_other')).toBe('kept');
  });
});
