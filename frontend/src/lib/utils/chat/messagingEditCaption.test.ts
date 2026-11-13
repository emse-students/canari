/**
 * A CAPTION EDIT LEAVES IN THE FRAME EVERY CLIENT ALREADY READS (owner, 2026-11-11).
 *
 * The decision was to add no wire shape: a media message's edit is the `edit_message` system event
 * a text edit has always been, `{ messageId, newContent, editedAt }`, and its text is the caption.
 * Every client at the `1.6.6` floor applies that text through `applyEditToBody`'s media branch
 * (#903, `v0.18.18`), so it replaces the caption and keeps the photo. An emptied caption leaves as
 * `newContent: ''`, which a client older than this change drops at its truthiness check - it keeps
 * the old caption, and nothing of the attachment is touched (legacy-compatibility).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '$lib/types';
import { decodeAppMessage } from '$lib/proto/codec';

const enqueued: { controlProto?: Uint8Array }[] = [];

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

vi.mock('./outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./outbox')>()),
  enqueueOutboxMessage: vi.fn(async (entry: { controlProto?: Uint8Array }) => {
    enqueued.push(entry);
  }),
}));

const { editMessage } = await import('./messaging');

const deps = {
  mlsService: {} as never,
  userId: 'me',
  deviceKeyB64: 'k',
  conversation: {
    id: 'g1',
    name: 'alice',
    lifecycle: 'active',
    messages: [],
  } as unknown as Conversation,
};

/** The system event the queued control frame carries, decoded as a receiver decodes it. */
function sentEvent(): { event: string; data: Record<string, unknown> } {
  const frame = decodeAppMessage(enqueued.at(-1)?.controlProto ?? new Uint8Array());
  return { event: frame?.system?.event ?? '', data: JSON.parse(frame?.system?.data ?? '{}') };
}

describe('editMessage - the frame of a caption edit', () => {
  it('is the edit_message event with the three keys a text edit has always had', async () => {
    await expect(editMessage('m1', 'new caption', 1000, deps)).resolves.toBe(true);
    const { event, data } = sentEvent();
    expect(event).toBe('edit_message');
    expect(data).toEqual({ messageId: 'm1', newContent: 'new caption', editedAt: 1000 });
  });

  it('carries an emptied caption as an empty string, the shape an older client drops', async () => {
    await editMessage('m1', '', 2000, deps);
    expect(sentEvent().data).toEqual({ messageId: 'm1', newContent: '', editedAt: 2000 });
  });
});
