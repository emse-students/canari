import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types';
import { mergeMessagePage } from './messageMerge';

/**
 * `mergeMessagePage` replaces four wholesale assignments of a freshly read page over the rendered
 * list. Each of them discarded whatever had arrived while the load ran, so the cases below are
 * written as the deliveries they lost rather than as properties of a merge.
 */
const msg = (id: string, atMs: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  senderId: 'peer',
  content: `{"kind":"text","text":"${id}"}`,
  timestamp: new Date(atMs),
  isOwn: false,
  ...extra,
});

describe('mergeMessagePage', () => {
  it('keeps a message that arrived while the page was being read', () => {
    // The measured defect: the page was read before `live` existed, so assigning it dropped `live`.
    const page = [msg('a', 1000), msg('b', 2000)];
    const current = [...page, msg('live', 3000)];
    expect(mergeMessagePage(current, page).map((m) => m.id)).toEqual(['a', 'b', 'live']);
  });

  it('keeps older messages already scrolled in, which no recent page carries', () => {
    const page = [msg('c', 3000), msg('d', 4000)];
    const current = [msg('old', 100), ...page];
    expect(mergeMessagePage(current, page).map((m) => m.id)).toEqual(['old', 'c', 'd']);
  });

  it('drops a message the page omits from INSIDE its own window', () => {
    // A tombstone or a genuine removal: the page speaks for this range, so its silence is an answer.
    const page = [msg('a', 1000), msg('c', 3000)];
    const current = [msg('a', 1000), msg('gone', 2000), msg('c', 3000)];
    expect(mergeMessagePage(current, page).map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('keeps an unsent message sitting inside the window', () => {
    // An outbox item queued before newer messages arrived can never appear in any page.
    const page = [msg('a', 1000), msg('c', 3000)];
    const current = [msg('a', 1000), msg('queued', 2000, { status: 'pending' }), msg('c', 3000)];
    expect(mergeMessagePage(current, page).map((m) => m.id)).toEqual(['a', 'queued', 'c']);
  });

  it('adds rows the page carries and memory does not', () => {
    const merged = mergeMessagePage([msg('b', 2000)], [msg('a', 1000), msg('b', 2000)]);
    expect(merged.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('removes nothing when the page is empty, which asserts nothing', () => {
    const current = [msg('a', 1000), msg('b', 2000)];
    expect(mergeMessagePage(current, []).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('upgrades an on-screen preview with the stored envelope', () => {
    const current = [msg('a', 1000, { content: 'Nouveau message', isFcmPreview: true })];
    const merged = mergeMessagePage(current, [msg('a', 1000)]);
    expect(merged[0].content).toContain('"kind"');
    expect(merged[0].isFcmPreview).toBe(false);
  });

  it('never downgrades an on-screen envelope back to a stored preview', () => {
    const current = [msg('a', 1000)];
    const page = [msg('a', 1000, { content: 'Nouveau message', isFcmPreview: true })];
    expect(mergeMessagePage(current, page)[0].content).toContain('"kind"');
  });

  it('keeps an optimistic read that the stored page has not caught up with', () => {
    // Reading is applied in memory before the network ACK; taking the page's array un-reads it and
    // the badge the user just cleared comes straight back.
    const current = [msg('a', 1000, { readBy: ['me'] })];
    const merged = mergeMessagePage(current, [msg('a', 1000, { readBy: [] })]);
    expect(merged[0].readBy).toEqual(['me']);
  });

  it('unions readers from both sides rather than choosing one', () => {
    const current = [msg('a', 1000, { readBy: ['me'] })];
    const merged = mergeMessagePage(current, [msg('a', 1000, { readBy: ['peer'] })]);
    expect([...(merged[0].readBy ?? [])].sort()).toEqual(['me', 'peer']);
  });

  it('takes the stored row for everything else, tombstones included', () => {
    const current = [msg('a', 1000)];
    const merged = mergeMessagePage(current, [msg('a', 1000, { isDeleted: true, isEdited: true })]);
    expect(merged[0].isDeleted).toBe(true);
    expect(merged[0].isEdited).toBe(true);
  });

  it('renders the page as-is when nothing is on screen yet', () => {
    const page = [msg('b', 2000), msg('a', 1000)];
    expect(mergeMessagePage([], page).map((m) => m.id)).toEqual(['a', 'b']);
  });
});
