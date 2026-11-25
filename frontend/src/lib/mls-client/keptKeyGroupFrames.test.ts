import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  KEPT_FRAMES_BYTE_BUDGET,
  forgetKeptFrame,
  keptFrameIds,
  keptFrameKey,
  keptFrameValue,
  keptFramesBytes,
  noteFrameKept,
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
    });
    expect(readKeptFrame(USER, 'g-1', 'other:1')).toBeNull();
    noteStateLedgerHeldByState(USER, keptFrameKey('g-1', 'bad:1'), '{not json');
    expect(readKeptFrame(USER, 'g-1', 'bad:1')).toBe('corrupt');
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

  it('opens a frame only while the set can take it, and never one no empty set could', () => {
    expect(roomToKeep(USER, 1000)).toBe('room');
    expect(roomToKeep(USER, KEPT_FRAMES_BYTE_BUDGET)).toBe('too-large');
    noteFrameKept(
      USER,
      keptFrameKey('g-1', '1:a'),
      'p:d',
      new Uint8Array(KEPT_FRAMES_BYTE_BUDGET / 2)
    );
    expect(keptFramesBytes(USER)).toBeGreaterThan(KEPT_FRAMES_BYTE_BUDGET / 2);
    expect(roomToKeep(USER, 100_000)).toBe('full');
    forgetKeptFrame(USER, 'g-1', '1:a');
    expect(roomToKeep(USER, 100_000)).toBe('room');
  });
});
