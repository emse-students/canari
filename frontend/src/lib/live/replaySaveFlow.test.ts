import { describe, expect, it, vi } from 'vitest';
import { saveReplayFlow, type SaveReplayFlowDeps } from './replaySaveFlow';
import { LiveRefusalError } from './api';

vi.mock('$lib/paraglide/messages', () => ({
  m: new Proxy(
    {},
    { get: (_t, key) => (p?: unknown) => `${String(key)}${p ? JSON.stringify(p) : ''}` }
  ),
}));

const post = {
  id: 'p1',
  liveId: 'live',
  publishedAt: '2026-11-09T10:00:00Z',
  createdAt: '2026-11-09T10:00:01Z',
};
const list = {
  liveId: 'live',
  postId: 'p1',
  key: 'k',
  segments: [{ index: 0, name: 's', bytes: 3_000_000, atMs: 0 }],
};

function deps(over: Partial<SaveReplayFlowDeps> = {}): SaveReplayFlowDeps {
  return {
    loadList: vi.fn(async () => list),
    confirm: vi.fn(async () => true),
    save: vi.fn(async () => ({ outcome: 'saved' as const, parts: 1 })),
    toast: vi.fn(),
    ...over,
  };
}

describe('saveReplayFlow', () => {
  it('says the size, then saves under the replay day', async () => {
    const d = deps();
    expect(await saveReplayFlow(post, d)).toBe('saved');
    expect(d.confirm).toHaveBeenCalledWith(3);
    expect(d.save).toHaveBeenCalledWith(list, '2026-11-09T10:00:00Z');
    expect(d.toast).not.toHaveBeenCalled();
  });
  it('writes nothing when the size is declined', async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    expect(await saveReplayFlow(post, d)).toBeNull();
    expect(d.save).not.toHaveBeenCalled();
  });
  it('says the replay is gone when the list is a 404', async () => {
    const d = deps({
      loadList: vi.fn(async () => {
        throw new LiveRefusalError(404, null, 'x', 'not-found', null, null, null);
      }),
    });
    expect(await saveReplayFlow(post, d)).toBeNull();
    expect(d.toast).toHaveBeenCalledWith('replay_save_gone', 'warning');
  });
  it('rethrows any other failure for the button to say', async () => {
    const d = deps({
      loadList: vi.fn(async () => {
        throw new Error('net');
      }),
    });
    await expect(saveReplayFlow(post, d)).rejects.toThrow('net');
  });
  it('says a save in several parts', async () => {
    const d = deps({ save: vi.fn(async () => ({ outcome: 'saved' as const, parts: 2 })) });
    await saveReplayFlow(post, d);
    expect(d.toast).toHaveBeenCalledWith('replay_save_done_parts{"parts":2}', 'info');
  });
  it('refuses a row that names no live', async () => {
    await expect(saveReplayFlow({ ...post, liveId: null }, deps())).rejects.toThrow(
      'names no live'
    );
  });
});
