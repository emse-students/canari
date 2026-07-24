import {
  isEnvelopeContent,
  isFcmPreviewContent,
  shouldUpgradeMessage,
  mergeMessageUpgrade,
} from './messageMerge';

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
