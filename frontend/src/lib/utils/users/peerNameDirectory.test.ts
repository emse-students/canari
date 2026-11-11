// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PEER_NAMES,
  forgetPeerNames,
  mergeStoredNames,
  notePeerName,
  openDirectory,
  readPeerName,
} from './peerNameDirectory';

describe('peerNameDirectory (memory half)', () => {
  beforeEach(() => forgetPeerNames());

  it('answers nothing until opened, for any account', () => {
    notePeerName('me', 'peer-1', 'Alice');
    expect(readPeerName('me', 'peer-1')).toBeNull();
  });

  it('folds names resolved before the key came into the opened directory', () => {
    notePeerName('me', 'peer-1', 'Alice');
    openDirectory('me');
    expect(readPeerName('me', 'peer-1')).toBe('Alice');
  });

  it('does not carry them to another account', () => {
    notePeerName('me', 'peer-1', 'Alice');
    openDirectory('other');
    expect(readPeerName('other', 'peer-1')).toBeNull();
    expect(readPeerName('me', 'peer-1')).toBeNull();
  });

  it('a stored copy never overrides what this launch resolved', () => {
    openDirectory('me');
    notePeerName('me', 'peer-1', 'Fresh');
    expect(mergeStoredNames('me', { 'peer-1': 'Stale', 'peer-2': 'Bob' })).toBe(1);
    expect(readPeerName('me', 'peer-1')).toBe('Fresh');
    expect(readPeerName('me', 'peer-2')).toBe('Bob');
  });

  it('keeps only the newest entries', () => {
    openDirectory('me');
    for (let i = 0; i < MAX_PEER_NAMES + 5; i++) notePeerName('me', `p${i}`, `Name ${i}`);
    expect(readPeerName('me', 'p0')).toBeNull();
    expect(readPeerName('me', `p${MAX_PEER_NAMES + 4}`)).not.toBeNull();
  });

  it('ignores an empty name or owner', () => {
    openDirectory('me');
    notePeerName('me', 'peer-2', '   ');
    notePeerName(null, 'peer-2', 'X');
    expect(readPeerName('me', 'peer-2')).toBeNull();
  });
});
