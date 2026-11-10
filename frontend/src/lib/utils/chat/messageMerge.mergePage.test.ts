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

  it('keeps the status of a queued own row the page ALSO carries - no stored row has one', () => {
    // Owner, web 1.6.9, 2026-11-10: a queued photo (stored with its outbox entry, so IN the page)
    // was re-marked pending at the login, then the conversation's stored page was drawn over it and
    // the row came back with no status - a check mark and an image placeholder for good.
    const queuedPhoto = msg('photo', 2000, {
      isOwn: true,
      senderId: 'me',
      content: '{"kind":"media","mediaId":""}',
    });
    const page = [msg('a', 1000), queuedPhoto, msg('c', 3000)];
    const current = [
      msg('a', 1000),
      { ...queuedPhoto, status: 'pending' as const },
      msg('c', 3000),
    ];

    const merged = mergeMessagePage(current, page);

    expect(merged.find((m) => m.id === 'photo')?.status).toBe('pending');
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
