import { handleSystemEvent } from './systemMessageHandler';
import { mkMediaEnvelope, mkTextEnvelope, parseEnvelope, serializeEnvelope } from '$lib/envelope';

/**
 * A MEDIA MESSAGE'S EDIT IS A CAPTION EDIT (owner, 2026-11-11).
 *
 * The frame is the one a text edit has always been - `edit_message` with `{ messageId, newContent,
 * editedAt }` - so no client meets a shape it does not know. What this pins is the RECEIVING side on
 * a media row: the caption is replaced, and the attachment reference (its blob id and key) is what
 * the row held, in memory and at rest. A client at the `1.6.6` floor runs the same media branch of
 * `applyEditToBody` (#903, `v0.18.18`); the one difference is an EMPTY text, which its truthiness
 * check drops - it keeps the old caption, never loses the photo.
 */

const PHOTO = {
  type: 'image' as const,
  mediaId: 'blob-1',
  key: 'k1',
  iv: 'iv1',
  mimeType: 'image/jpeg',
  size: 42,
};

function makeCtx(content: string) {
  const conversations = new Map<string, any>();
  const row = { id: 'm1', senderId: 'peer', content, readBy: [] };
  conversations.set('g1', { id: 'g1', unreadCount: 0, messages: [row] });
  const write = vi.fn();
  return {
    mlsService: {},
    storage: {
      write,
      mergeMessages: vi.fn(async function (_c: string, ids: string[], merge: (r: any) => any) {
        const next = merge({ ...row });
        if (!next) return new Set();
        write(ids[0], next);
        return new Set(ids);
      }),
      getMessagesByIds: vi.fn(async () => ({
        rows: new Map([['m1', row]]),
        unreadable: new Set(),
      })),
    },
    userId: 'me',
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: {},
    convoKey: 'g1',
    senderNorm: 'peer',
    persistMlsStateNow: vi.fn(),
  };
}

const shown = (ctx: ReturnType<typeof makeCtx>) =>
  parseEnvelope((ctx.conversations.get('g1') as any).messages[0].content);
const stored = (ctx: ReturnType<typeof makeCtx>) =>
  parseEnvelope(ctx.storage.write.mock.calls[0][1].content);

describe('handleSystemEvent - an edit of a media message replaces its caption only', () => {
  it('replaces the caption and keeps the attachment, in memory AND at rest', async () => {
    const ctx = makeCtx(serializeEnvelope(mkMediaEnvelope(PHOTO, 'old caption')));
    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'new caption', editedAt: 1000 },
      ctx as any
    );

    for (const env of [shown(ctx), stored(ctx)]) {
      expect(env.kind).toBe('media');
      expect(env.kind === 'media' && env.caption).toBe('new caption');
      expect(env.kind === 'media' && env.media).toEqual(PHOTO);
    }
    expect((ctx.conversations.get('g1') as any).messages[0].isEdited).toBe(true);
    expect(ctx.storage.write.mock.calls[0][1].isEdited).toBe(true);
  });

  it('removes the caption on an EMPTY text, the photo kept', async () => {
    const ctx = makeCtx(serializeEnvelope(mkMediaEnvelope(PHOTO, 'to remove')));
    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: '', editedAt: 1000 },
      ctx as any
    );

    const env = shown(ctx);
    expect(env.kind === 'media' && env.caption).toBeUndefined();
    expect(env.kind === 'media' && env.media).toEqual(PHOTO);
    expect(stored(ctx).kind).toBe('media');
  });

  it('DROPS an empty text on a TEXT message, and says so', async () => {
    const ctx = makeCtx(serializeEnvelope(mkTextEnvelope('hello')));
    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: '', editedAt: 1000 },
      ctx as any
    );

    const env = shown(ctx);
    expect(env.kind === 'text' && env.text).toBe('hello');
    expect(ctx.storage.write).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('edits only a caption'));
  });
});
