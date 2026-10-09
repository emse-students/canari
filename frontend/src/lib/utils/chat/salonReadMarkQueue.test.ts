import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeReadWatermarks, watermarkAfterReading, watermarkFor } from './readState';
import {
  flushSalonReadMarks,
  owedSalonReadMarks,
  recordSalonReadMark,
  salonMarksAfterLoad,
} from './salonReadMarkQueue';

describe('salonReadMarkQueue', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('keeps the highest mark per salon, written before any network', () => {
    recordSalonReadMark('U1', 'channel_a', 100, 90);
    recordSalonReadMark('U1', 'channel_a', 50);
    expect(owedSalonReadMarks('u1')).toEqual({ channel_a: { at: 100, serverAt: 90 } });
  });

  it('a refused POST keeps the mark owed and the next flush delivers it', async () => {
    recordSalonReadMark('u1', 'channel_a', 100);
    const send = vi.fn().mockRejectedValueOnce(new Error('API Error 500')).mockResolvedValue(100);
    expect(await flushSalonReadMarks('u1', send)).toBe(0);
    expect(owedSalonReadMarks('u1')).toEqual({ channel_a: { at: 100 } });
    // "reload": the owed mark is read back from storage
    expect(await flushSalonReadMarks('u1', send)).toBe(1);
    expect(owedSalonReadMarks('u1')).toEqual({});
  });

  it('a mark raised while the call was in flight stays owed', async () => {
    recordSalonReadMark('u1', 'channel_a', 100);
    const send = vi.fn(async () => {
      recordSalonReadMark('u1', 'channel_a', 200);
    });
    await flushSalonReadMarks('u1', send);
    expect(owedSalonReadMarks('u1')).toEqual({ channel_a: { at: 200 } });
  });
});

describe("salonMarksAfterLoad - the reader's own mark is the server's, or one still owed", () => {
  // The 2026-10-09 #infos report: the server's mark at 09:03:13.234, two real messages at 09:09,
  // two locally drawn system notices after them, and a mark this device had advanced to 09:09:31
  // and never delivered.
  const SERVER_MARK = Date.parse('2026-10-09T09:03:13.234Z');
  const REAL_1 = Date.parse('2026-10-09T09:09:16.000Z');
  const REAL_2 = Date.parse('2026-10-09T09:09:31.000Z');
  const msg = (id: string, at: number, isSystem = false) => ({
    id,
    senderId: isSystem ? 'system' : 'peer',
    isOwn: false,
    isSystem,
    timestamp: new Date(at),
  });
  const salon = [
    msg('m1', REAL_1),
    msg('m2', REAL_2),
    msg('s1', REAL_2 + 60_000, true),
    msg('s2', REAL_2 + 120_000, true),
  ];

  beforeEach(() => localStorage.clear());

  it('reproduces the defect: a max-merge keeps the undelivered belief, so reading posts nothing', () => {
    const believed = { me: REAL_2 };
    const merged = mergeReadWatermarks(believed, { me: SERVER_MARK }) ?? believed;
    const held = watermarkFor(merged, 'me');
    expect(watermarkAfterReading(salon, held)).toBe(held);
  });

  it("takes the server's mark over a belief that is not owed, so reading posts up to the newest real message", () => {
    const marks = salonMarksAfterLoad(
      { me: REAL_2, peer: 5 },
      { me: SERVER_MARK, peer: 10 },
      'ME',
      undefined,
      'channel_infos'
    );
    expect(marks).toEqual({ me: SERVER_MARK, peer: 10 });
    const held = watermarkFor(marks, 'me');
    // The system notices below the last messages never become the candidate.
    expect(watermarkAfterReading(salon, held)).toBe(REAL_2);
  });

  it('keeps a mark the device still owes, since the queue delivers it', () => {
    expect(salonMarksAfterLoad({ me: REAL_2 }, { me: SERVER_MARK }, 'me', REAL_1, 'c')).toEqual({
      me: REAL_1,
    });
  });

  it('drops the own entry when the server holds none and nothing is owed', () => {
    expect(salonMarksAfterLoad({ me: REAL_2 }, {}, 'me', undefined, 'c')).toBeUndefined();
  });

  it('keeps everything as it was when the marks could not be loaded', () => {
    const current = { me: REAL_2 };
    expect(salonMarksAfterLoad(current, undefined, 'me', undefined, 'c')).toBe(current);
  });
});
