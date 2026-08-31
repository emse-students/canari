import { describe, it, expect, vi } from 'vitest';
import { applyNativeReadWatermarks } from './readWatermarkCache';
import type { Conversation } from '$lib/types';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ appendLog: () => {} }));

/**
 * The half of "mark as read from the shade" that never travelled.
 *
 * The `read_watermark` frame reaches peers; the phone the user is holding learned nothing, so the
 * badge came back at the next open. These tests pin the properties that make the hand-off file a
 * safe way to tell it: the merge only ever moves forward, the count is DERIVED from the watermark
 * rather than written beside it, and a conversation nobody acknowledged is left untouched - which
 * is what keeps a stale file from clearing a badge it has no business clearing.
 */
describe('applyNativeReadWatermarks', () => {
  const ME = 'ME-USER';
  const meNorm = ME.toLowerCase();

  const msg = (id: string, at: number, senderId = 'peer') =>
    ({
      id,
      senderId,
      timestamp: new Date(at),
      isOwn: senderId === meNorm,
      isSystem: false,
    }) as never;

  const convo = (id: string, messages: unknown[], watermarks?: Record<string, number>) =>
    ({
      id,
      name: id,
      messages,
      unreadCount: messages.length,
      readWatermarks: watermarks,
      lifecycle: 'active',
    }) as unknown as Conversation;

  const mapOf = (...cs: Conversation[]) => new Map(cs.map((c) => [c.id, c]));

  it('advances the watermark and recomputes the count from it', () => {
    const convs = mapOf(convo('g1', [msg('a', 1000), msg('b', 2000), msg('c', 3000)]));
    const changed = applyNativeReadWatermarks([{ groupId: 'g1', at: 2000 }], convs, ME);

    expect(changed).toEqual(['g1']);
    expect(convs.get('g1')!.readWatermarks![meNorm]).toBe(2000);
    // Derived, not asserted: only `c` is still ahead of the watermark.
    expect(convs.get('g1')!.unreadCount).toBe(1);
  });

  /** The merge is `max` on both ends, so a replayed or reordered line must change nothing. */
  it('never moves a watermark backwards', () => {
    const convs = mapOf(convo('g1', [msg('a', 1000), msg('b', 5000)], { [meNorm]: 5000 }));
    const changed = applyNativeReadWatermarks([{ groupId: 'g1', at: 1000 }], convs, ME);

    expect(changed).toEqual([]);
    expect(convs.get('g1')!.readWatermarks![meNorm]).toBe(5000);
    expect(convs.get('g1')!.unreadCount).toBe(2);
  });

  it('leaves every conversation the file does not name alone', () => {
    const convs = mapOf(convo('g1', [msg('a', 1000)]), convo('g2', [msg('b', 1000)]));
    applyNativeReadWatermarks([{ groupId: 'g1', at: 1000 }], convs, ME);

    expect(convs.get('g2')!.unreadCount).toBe(1);
    expect(convs.get('g2')!.readWatermarks).toBeUndefined();
  });

  /**
   * A LINE THAT IS NOT A WATERMARK MUST NOT BE ONE. `at: 0` is what the native side writes when the
   * notification predates the intent extra; treating it as a watermark would merge a zero, and
   * treating a missing `at` as "now" would mark unread messages read - the exact failure
   * `watermarkAfterReading` exists to prevent.
   */
  it('drops an entry that carries no usable instant', () => {
    const convs = mapOf(convo('g1', [msg('a', 1000)]));
    const changed = applyNativeReadWatermarks(
      [
        { groupId: 'g1', at: 0 },
        { groupId: 'g1', at: Number.NaN },
        { groupId: '', at: 5000 },
        { groupId: 'g1' } as never,
      ],
      convs,
      ME
    );

    expect(changed).toEqual([]);
    expect(convs.get('g1')!.unreadCount).toBe(1);
  });

  /** Two lines for one group cost one merge, not two - the file's shape is not a guarantee. */
  it('collapses several lines for the same conversation to the highest', () => {
    const convs = mapOf(convo('g1', [msg('a', 1000), msg('b', 2000), msg('c', 3000)]));
    applyNativeReadWatermarks(
      [
        { groupId: 'g1', at: 1000 },
        { groupId: 'g1', at: 3000 },
        { groupId: 'g1', at: 2000 },
      ],
      convs,
      ME
    );

    expect(convs.get('g1')!.readWatermarks![meNorm]).toBe(3000);
    expect(convs.get('g1')!.unreadCount).toBe(0);
  });

  /** The map key and the conversation id coincide today; the lookup must not depend on it. */
  it('matches on the conversation id, not on the map key', () => {
    const convs = new Map([['some-other-key', convo('g1', [msg('a', 1000)])]]);
    const changed = applyNativeReadWatermarks([{ groupId: 'g1', at: 1000 }], convs, ME);

    expect(changed).toEqual(['some-other-key']);
    expect(convs.get('some-other-key')!.unreadCount).toBe(0);
  });
});
