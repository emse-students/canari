// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAX_PEER_NAMES, clearPeerNames, notePeerName, readPeerName } from './peerNameDirectory';

const flushWrite = () => Promise.resolve();

describe('peerNameDirectory', () => {
  beforeEach(() => clearPeerNames());

  it('answers a name noted by the same account, synchronously', () => {
    notePeerName('me', 'peer-1', 'Alice Martin');
    expect(readPeerName('me', 'peer-1')).toBe('Alice Martin');
  });

  it('survives a cold start: a fresh read of storage names the row before any network', async () => {
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flushWrite();
    // Cold start: the in-memory state is gone, only the stored blob remains.
    vi.resetModules();
    const cold = await import('./peerNameDirectory');
    expect(cold.readPeerName('me', 'peer-1')).toBe('Alice Martin');
  });

  it('never serves another account its names', async () => {
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flushWrite();
    vi.resetModules();
    const cold = await import('./peerNameDirectory');
    expect(cold.readPeerName('someone-else', 'peer-1')).toBeNull();
  });

  it('keeps only the newest entries', () => {
    for (let i = 0; i < MAX_PEER_NAMES + 5; i++) notePeerName('me', `p${i}`, `Name ${i}`);
    expect(readPeerName('me', 'p0')).toBeNull();
    expect(readPeerName('me', `p${MAX_PEER_NAMES + 4}`)).toBe(`Name ${MAX_PEER_NAMES + 4}`);
  });

  it('ignores an empty name or owner', () => {
    notePeerName('me', 'peer-2', '   ');
    notePeerName(null, 'peer-2', 'X');
    expect(readPeerName('me', 'peer-2')).toBeNull();
  });
});
