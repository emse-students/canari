import { describe, expect, it, vi } from 'vitest';
import { liveAudienceFilter, liveMentionRoster, mentionsViewer } from './liveMention';
import type { LiveChatLine } from './liveChat';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const HOST = 'd'.repeat(64);

const line = (authorId: string, over: Partial<LiveChatLine> = {}): LiveChatLine => ({
  id: null,
  clientId: authorId + Math.random(),
  authorId,
  text: 'x',
  seq: 1,
  status: 'sent',
  mine: false,
  ...over,
});

describe('liveMentionRoster', () => {
  it('lists whoever the chat showed, the latest speaker first in the picker order', () => {
    const roster = liveMentionRoster([line(A), line(B), line(A)], null);
    const byRecency = [...roster].sort((x, y) => (y.lastSpokeAt ?? 0) - (x.lastSpokeAt ?? 0));
    expect(byRecency.map((r) => r.id)).toEqual([A, B]);
  });

  it('counts an arrival, not the folded rest of a crowd or an anonymous line', () => {
    const roster = liveMentionRoster(
      [line(A, { kind: 'arrival' }), line('', { kind: 'arrivals-more', more: 4 }), line(C)],
      null
    );
    expect(roster.map((r) => r.id).sort()).toEqual([A, C]);
  });

  it('adds the broadcaster once, after anybody who spoke', () => {
    const quiet = liveMentionRoster([], HOST);
    expect(quiet).toEqual([{ id: HOST, lastSpokeAt: 0 }]);
    const spoke = liveMentionRoster([line(HOST.toUpperCase()), line(A)], HOST);
    expect(spoke.filter((r) => r.id === HOST)).toHaveLength(1);
    expect(spoke.find((r) => r.id === HOST)!.lastSpokeAt).toBe(1);
  });
});

describe('liveAudienceFilter', () => {
  const users = [
    { id: A, displayName: 'Ada' },
    { id: B, displayName: 'Bob' },
  ];

  it('keeps only the accounts the server says a mention may reach, whatever the case', async () => {
    const audienceOf = vi.fn(async () => [B.toUpperCase()]);
    expect(await liveAudienceFilter(audienceOf)(users)).toEqual([users[1]]);
    expect(audienceOf).toHaveBeenCalledWith([A, B]);
  });

  it('asks nothing for no one', async () => {
    const audienceOf = vi.fn(async () => []);
    expect(await liveAudienceFilter(audienceOf)([])).toEqual([]);
    expect(audienceOf).not.toHaveBeenCalled();
  });

  it('a failed ask offers nobody from the directory, never an unfiltered list, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const audienceOf = vi.fn(async () => {
      throw new Error('down');
    });
    expect(await liveAudienceFilter(audienceOf)(users)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('mentionsViewer', () => {
  it('is true only for a token naming the viewer', () => {
    expect(mentionsViewer(`hey @[${A}]`, A)).toBe(true);
    expect(mentionsViewer(`hey @[${A}]`, A.toUpperCase())).toBe(true);
    expect(mentionsViewer(`hey @[${B}]`, A)).toBe(false);
    expect(mentionsViewer(`hey ${A}`, A)).toBe(false);
    expect(mentionsViewer(`hey @[${A}]`, null)).toBe(false);
  });
});
