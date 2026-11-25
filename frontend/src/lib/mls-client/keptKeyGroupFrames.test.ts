import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  KEPT_FRAME_MAX_BYTES,
  KEPT_FRAMES_BYTE_BUDGET,
  describeKeptFrames,
  forgetKeptFrame,
  forgetKeptFramesOfGroup,
  keptFrameIds,
  keptFrameKey,
  keptFrameValue,
  keptFramesBytes,
  noteFrameKept,
  noteKeptFrameFailed,
  readKeptFrame,
  roomToKeep,
} from './keptKeyGroupFrames';
import {
  STATE_LEDGER,
  hydrateStateLedgers,
  noteStateLedgerHeldByState,
  resetStateLedgersForTests,
  takeStagedStateLedgers,
} from './stateLedgers';

/**
 * The kept-frame ledger (mls-desync-prevention section 11): its value is the string `mls-core`
 * writes, its keys name a group and a frame, and its bytes are bounded before a frame is decrypted.
 * The route's behaviour is `BaseMlsService.distributionGroup.test.ts`'s subject.
 */
const USER = 'u';

beforeEach(() => {
  resetStateLedgersForTests();
  hydrateStateLedgers(USER, {});
});

describe('the kept value', () => {
  it('is the exact string mls-core writes: sender, then standard padded base64', () => {
    // `kept_key_group_frame.rs` asserts the Rust half builds this same string.
    expect(keptFrameValue('peer:dev', new Uint8Array([4, 2]))).toBe(
      '{"sender":"peer:dev","plaintext":"BAI="}'
    );
    expect(keptFrameValue(null, new Uint8Array([]))).toBe('{"sender":null,"plaintext":""}');
    // `app_ledgers.rs` pins `KeptFrame { sender: None, .. }` to this same string.
    expect(keptFrameValue(null, new Uint8Array([4, 2]))).toBe('{"sender":null,"plaintext":"BAI="}');
  });

  it('counts failed runs in the value itself, so a restart reads them back', () => {
    noteFrameKept(USER, keptFrameKey('g-1', '3:abc'), 'peer:dev', new Uint8Array([1]));
    expect(noteKeptFrameFailed(USER, 'g-1', '3:abc')).toBe(1);
    expect(noteKeptFrameFailed(USER, 'g-1', '3:abc')).toBe(2);
    const staged = takeStagedStateLedgers(USER)!;
    expect(staged[keptFrameKey('g-1', '3:abc')]).toBe(
      '{"sender":"peer:dev","plaintext":"AQ==","failures":2}'
    );

    resetStateLedgersForTests();
    hydrateStateLedgers(USER, staged as Record<string, string>);
    expect(readKeptFrame(USER, 'g-1', '3:abc')).toMatchObject({ failures: 2 });
    expect(describeKeptFrames(USER, 'g-1')).toMatch(/^1 frame\(s\), 2 failed run\(s\), \d+ bytes$/);
    expect(describeKeptFrames(USER, 'g-2')).toBe('none');
    // Nothing kept, nothing counted.
    expect(noteKeptFrameFailed(USER, 'g-2', '1:a')).toBe(0);
  });

  it('lives under the prefix mls-core refuses to write outside of', () => {
    const rust = readFileSync(resolve(process.cwd(), 'mls-core/src/app_ledgers.rs'), 'utf8');
    const declared = /pub const KEPT_FRAME_PREFIX: &str = "([^"]+)";/.exec(rust)?.[1];
    expect(declared).toBe(STATE_LEDGER.keptFramePrefix);
    expect(keptFrameKey('g', 'a:b')).toBe(`${declared}g:a:b`);
  });

  it('reads back what was kept, and calls a value that does not parse corrupt', () => {
    noteFrameKept(USER, keptFrameKey('g-1', '3:abc'), 'peer:dev', new Uint8Array([1, 2, 3]));
    expect(readKeptFrame(USER, 'g-1', '3:abc')).toEqual({
      groupId: 'g-1',
      fingerprint: '3:abc',
      verifiedSender: 'peer:dev',
      plaintext: new Uint8Array([1, 2, 3]),
      failures: 0,
    });
    expect(readKeptFrame(USER, 'g-1', 'other:1')).toBeNull();
    noteStateLedgerHeldByState(USER, keptFrameKey('g-1', 'bad:1'), '{not json');
    expect(readKeptFrame(USER, 'g-1', 'bad:1')).toBe('corrupt');
    noteStateLedgerHeldByState(
      USER,
      keptFrameKey('g-1', 'bad:2'),
      '{"sender":"p:d","plaintext":"","failures":"x"}'
    );
    expect(readKeptFrame(USER, 'g-1', 'bad:2')).toBe('corrupt');
  });
});

describe('the kept set', () => {
  it('names each frame by its group and its fingerprint, a group id with colons included', () => {
    noteFrameKept(USER, keptFrameKey('g-1', '3:abc'), 'p:d', new Uint8Array([1]));
    noteFrameKept(USER, keptFrameKey('ws:salon', '9:zz'), 'p:d', new Uint8Array([1]));
    expect(keptFrameIds(USER)).toEqual([
      { groupId: 'g-1', fingerprint: '3:abc' },
      { groupId: 'ws:salon', fingerprint: '9:zz' },
    ]);
  });

  it('is forgotten through the next checkpoint, never kept in memory only', () => {
    noteFrameKept(USER, keptFrameKey('g-1', '3:abc'), 'p:d', new Uint8Array([1]));
    // Kept by the state, so nothing is staged for it.
    expect(takeStagedStateLedgers(USER)).toBeUndefined();
    forgetKeptFrame(USER, 'g-1', '3:abc');
    expect(keptFrameIds(USER)).toEqual([]);
    expect(takeStagedStateLedgers(USER)).toEqual({ [keptFrameKey('g-1', '3:abc')]: null });
  });

  it('forgets every frame of one group, and only that group', () => {
    noteFrameKept(USER, keptFrameKey('g-1', '3:abc'), 'p:d', new Uint8Array([1]));
    noteFrameKept(USER, keptFrameKey('g-2', '9:zz'), 'p:d', new Uint8Array([1]));
    expect(forgetKeptFramesOfGroup(USER, 'g-1')).toBe(1);
    expect(keptFrameIds(USER)).toEqual([{ groupId: 'g-2', fingerprint: '9:zz' }]);
  });

  it('opens a frame only while the set can take it, and never one past a group share', () => {
    expect(roomToKeep(USER, 1000)).toBe('room');
    expect(roomToKeep(USER, KEPT_FRAME_MAX_BYTES)).toBe('too-large');
    // Two shares in all: one group holding its largest frame leaves another room for its own.
    const nearShare = Math.floor(((KEPT_FRAME_MAX_BYTES - 1024) * 3) / 4);
    noteFrameKept(USER, keptFrameKey('g-1', '1:a'), 'p:d', new Uint8Array(nearShare));
    expect(roomToKeep(USER, nearShare)).toBe('room');
    noteFrameKept(USER, keptFrameKey('g-2', '1:b'), 'p:d', new Uint8Array(nearShare));
    expect(keptFramesBytes(USER)).toBeGreaterThan(KEPT_FRAMES_BYTE_BUDGET - 4096);
    expect(roomToKeep(USER, 100_000)).toBe('full');
    forgetKeptFrame(USER, 'g-1', '1:a');
    expect(roomToKeep(USER, 100_000)).toBe('room');
  });
});
