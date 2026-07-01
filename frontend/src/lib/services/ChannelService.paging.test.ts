import { describe, it, expect, vi } from 'vitest';
import { ChannelService, type ChannelMessageRow } from './ChannelService';

/** Builds a minimal channel message row with a given id and createdAt (ISO). */
function row(id: string, createdAt: string): ChannelMessageRow {
  return {
    id,
    channelId: 'ch1',
    senderId: 'u1',
    ciphertext: 'x',
    nonce: 'n',
    keyVersion: 1,
    replyTo: null,
    createdAt,
    pinned: false,
    poll: null,
  };
}

describe('ChannelService.fetchAllChannelMessages', () => {
  it('follows the createdAt cursor across full pages until a short page ends history', async () => {
    const svc = new ChannelService();
    // Two full pages (pageSize 2) then a short final page.
    const pages: ChannelMessageRow[][] = [
      [row('m5', '2026-07-01T00:05:00.000Z'), row('m4', '2026-07-01T00:04:00.000Z')],
      [row('m3', '2026-07-01T00:03:00.000Z'), row('m2', '2026-07-01T00:02:00.000Z')],
      [row('m1', '2026-07-01T00:01:00.000Z')],
    ];
    const listMessages = vi
      .spyOn(svc, 'listMessages')
      .mockImplementation(async () => pages.shift() ?? []);

    const { rows, capped } = await svc.fetchAllChannelMessages('channel_ch1', { pageSize: 2 });

    expect(rows.map((r) => r.id)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
    expect(capped).toBe(false);
    // Cursor passed is the oldest createdAt of the previous page.
    expect(listMessages.mock.calls[0][2]).toBeUndefined();
    expect(listMessages.mock.calls[1][2]).toBe('2026-07-01T00:04:00.000Z');
    expect(listMessages.mock.calls[2][2]).toBe('2026-07-01T00:02:00.000Z');
  });

  it('stops and reports capped once the cap is reached', async () => {
    const svc = new ChannelService();
    vi.spyOn(svc, 'listMessages').mockImplementation(async () => [
      row('a', '2026-07-01T00:02:00.000Z'),
      row('b', '2026-07-01T00:01:00.000Z'),
    ]);

    const { rows, capped } = await svc.fetchAllChannelMessages('channel_ch1', {
      pageSize: 2,
      cap: 3,
    });

    expect(rows).toHaveLength(3);
    expect(capped).toBe(true);
  });

  it('returns empty (not capped) when the channel has no messages', async () => {
    const svc = new ChannelService();
    vi.spyOn(svc, 'listMessages').mockResolvedValue([]);

    const { rows, capped } = await svc.fetchAllChannelMessages('channel_ch1');

    expect(rows).toEqual([]);
    expect(capped).toBe(false);
  });
});
