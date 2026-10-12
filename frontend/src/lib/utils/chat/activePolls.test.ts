import { describe, expect, it } from 'vitest';
import { mkPollEnvelope, mkTextEnvelope, serializeEnvelope } from '$lib/envelope';
import type { ChannelPollMeta } from '$lib/services/ChannelService';
import { openSalonPolls, salonPolls } from './activePolls';

const T = Date.UTC(2026, 9, 12, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const options = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
];

function poll(id: string, endsAt: string | null) {
  return { id, content: serializeEnvelope(mkPollEnvelope(`Q ${id}`, options, false, endsAt)) };
}

function meta(endsAt: string | null, closed: boolean): ChannelPollMeta {
  return { optionIds: ['a', 'b'], multipleChoice: false, endsAt, votesByUser: {}, closed };
}

describe('salonPolls', () => {
  it('keeps only poll messages, in thread order, with the deadline the message carries', () => {
    const text = { id: 't1', content: serializeEnvelope(mkTextEnvelope('hello')) };
    const out = salonPolls([poll('p1', null), text, poll('p2', iso(T + 60_000))], () => undefined);
    expect(out.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(out[1]).toEqual({ id: 'p2', question: 'Q p2', endsAt: iso(T + 60_000), closed: false });
  });

  it("takes the server's endsAt and closed once the tally is known - where an early close lands", () => {
    const out = salonPolls([poll('p1', null)], () => meta(iso(T - 1), true));
    expect(out[0]).toMatchObject({ endsAt: iso(T - 1), closed: true });
  });
});

describe('openSalonPolls', () => {
  it('counts a poll without a deadline that the server has not closed', () => {
    expect(
      openSalonPolls(
        salonPolls([poll('p1', null)], () => undefined),
        T
      )
    ).toHaveLength(1);
  });

  it('drops a poll closed early by the server, although its message has no deadline', () => {
    const polls = salonPolls([poll('p1', null), poll('p2', null)], (id) =>
      id === 'p1' ? meta(iso(T + 3_600_000), true) : undefined
    );
    expect(openSalonPolls(polls, T).map((p) => p.id)).toEqual(['p2']);
  });

  it('drops a poll from the instant its deadline is reached, judged against the instant given', () => {
    const polls = salonPolls([poll('p1', iso(T))], () => undefined);
    expect(openSalonPolls(polls, T - 1)).toHaveLength(1);
    expect(openSalonPolls(polls, T)).toHaveLength(0);
  });
});
