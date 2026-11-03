import {
  isEnvelopeContent,
  isFcmPreviewContent,
  shouldUpgradeMessage,
  mergeMessageUpgrade,
  previewUpgradeOnto,
} from './messageMerge';
import type { StoredMessage } from '$lib/db/types';

describe('messageMerge', () => {
  it('detects envelope JSON vs plain preview', () => {
    expect(isEnvelopeContent('{"kind":"text","text":"hi"}')).toBe(true);
    expect(isFcmPreviewContent('Hello from notification')).toBe(true);
  });

  it('upgrades FCM preview when MLS envelope arrives', () => {
    const existing = {
      content: 'preview text',
      isFcmPreview: true,
    };
    const incoming =
      '{"kind":"text","text":"full message","replyTo":{"id":"1","senderId":"a","content":"q"}}';
    expect(shouldUpgradeMessage(existing, incoming)).toBe(true);

    const merged = mergeMessageUpgrade(
      {
        id: 'm1',
        senderId: 'user-a',
        content: 'preview text',
        timestamp: new Date(1000),
        isOwn: false,
        isFcmPreview: true,
      },
      {
        content: incoming,
        replyTo: { id: '1', senderId: 'a', content: 'q' },
      }
    );
    expect(merged.isFcmPreview).toBe(false);
    expect(merged.content).toBe(incoming);
  });

  it('does not upgrade full envelope with duplicate delivery', () => {
    const existing = {
      content: '{"kind":"text","text":"already full"}',
      isFcmPreview: false,
    };
    expect(shouldUpgradeMessage(existing, '{"kind":"text","text":"other"}')).toBe(false);
  });
});

describe('a deleted preview', () => {
  it('is never upgraded - the deletion is final', () => {
    expect(
      shouldUpgradeMessage(
        { content: 'deleted', isFcmPreview: true, isDeleted: true },
        '{"kind":"text","text":"body"}'
      )
    ).toBe(false);
  });
});

describe('previewUpgradeOnto - a preview upgrade folded onto the row as it stands', () => {
  const BODY = '{"kind":"text","text":"the body"}';
  const preview = (over: Partial<StoredMessage> = {}): StoredMessage => ({
    id: 'm1',
    conversationId: 'c',
    senderId: 'alice',
    content: 'caption',
    timestamp: 1,
    isFcmPreview: true,
    ...over,
  });
  const upgrade: StoredMessage = {
    id: 'm1',
    conversationId: 'c',
    senderId: 'alice',
    content: BODY,
    timestamp: 1,
    serverTimestamp: 7,
    isFcmPreview: false,
  };

  it('keeps a reaction the stored preview took after memory was read (the bulk row carries none)', () => {
    const bob = { userId: 'bob', emoji: '👍', at: 5 };
    const next = previewUpgradeOnto(preview({ reactions: [bob] }), upgrade);
    expect(next).toMatchObject({ content: BODY, isFcmPreview: false, serverTimestamp: 7 });
    expect(next?.reactions).toEqual([bob]);
  });

  it('unions both sides reactions, and keeps an edit the upgrade does not carry', () => {
    const next = previewUpgradeOnto(
      preview({ reactions: [{ userId: 'bob', emoji: '👍', at: 5 }] }),
      { ...upgrade, reactions: [{ userId: 'carol', emoji: '🎉', at: 6 }], isDeleted: false }
    );
    expect(next?.reactions?.map((r) => r.userId).sort()).toEqual(['bob', 'carol']);
    expect(next?.isDeleted).toBeUndefined();
  });

  it('leaves a row that is no longer a preview - deleted, or upgraded by another writer', () => {
    expect(previewUpgradeOnto(preview({ isDeleted: true }), upgrade)).toBeNull();
    expect(previewUpgradeOnto(preview({ content: BODY, isFcmPreview: false }), upgrade)).toBeNull();
  });
});
