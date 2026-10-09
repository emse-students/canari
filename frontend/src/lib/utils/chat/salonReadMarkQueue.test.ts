import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSalonReadMarks, owedSalonReadMarks, recordSalonReadMark } from './salonReadMarkQueue';

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
