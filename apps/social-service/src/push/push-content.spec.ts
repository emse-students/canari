import {
  mentionContent,
  replyContent,
  commentContent,
  reactionContent,
  formOpeningSoonContent,
  formOpenContent,
  pushContentData,
  type PushContent,
} from './push-content';
import { PushService } from './push.service';

/**
 * The services do not know the recipient's language, so what they must send is WHAT the
 * notification is - never the sentence. What is pinned here is that seam: every builder emits a
 * key, and the payload carries the key and its data rather than only prose.
 *
 * The other half of the seam - that each key is spelled in all six native tables and handled by
 * all three native composers - is `frontend/src/lib/mobile/nativeStrings.test.ts`. Neither test can
 * see what the other checks, and a key with no resource fails no build: the phone would quietly
 * keep the server's compatibility wording, which is exactly the "one language for everyone" this
 * replaced, only now looking deliberate.
 */
describe('push content', () => {
  const ALL: [string, PushContent][] = [
    ['mention', mentionContent('Claire', 'hello')],
    ['reply', replyContent('Claire', 'hello')],
    ['comment', commentContent('Claire', 'hello')],
    ['reaction', reactionContent('Claire', '😂')],
    ['formOpeningSoon', formOpeningSoonContent()],
    ['formOpen', formOpenContent()],
  ];

  it.each(ALL)('%s carries a key, not only a sentence', (_name, content) => {
    expect(content.key).toMatch(/^[a-z_]+$/);
    const data = pushContentData(content);
    expect(data.contentKey).toBe(content.key);
    expect(typeof data.actorName).toBe('string');
    expect(typeof data.contentArg).toBe('string');
  });

  it('gives every kind its own key, so none can be rendered as another', () => {
    const keys = ALL.map(([, c]) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('puts the untranslatable pieces in data and nothing else', () => {
    // A name is a proper noun and the reaction is an emoji; neither is ever translated. The
    // author's own text is not translated either - it is what somebody typed.
    expect(pushContentData(reactionContent('Claire', '😂'))).toEqual({
      contentKey: 'social_reaction',
      actorName: 'Claire',
      contentArg: '😂',
    });
    expect(pushContentData(formOpenContent())).toEqual({
      contentKey: 'form_open',
      actorName: '',
      contentArg: '',
    });
  });

  it('still carries the old wording, for the clients that only read that', () => {
    // Removing these before the shim's date blanks the notification on every phone installed today.
    for (const [, content] of ALL) {
      expect(content.legacyTitle.length).toBeGreaterThan(0);
      expect(content.legacyBody.length).toBeGreaterThan(0);
    }
  });
});

describe('PushService.notifyContent', () => {
  it('sends the key alongside the caller data and the legacy wording', async () => {
    process.env.INTERNAL_SECRET = 'test-secret';
    const service = new PushService();
    const sent: unknown[] = [];
    const fetchMock = jest.fn((_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await service.notifyContent('user-1', commentContent('Claire', 'nice post'), {
      type: 'social',
      postId: 'p1',
    });

    expect(sent).toHaveLength(1);
    const payload = sent[0] as { title: string; body: string; data: Record<string, string> };
    expect(payload.data).toEqual({
      type: 'social',
      postId: 'p1',
      contentKey: 'social_comment',
      actorName: 'Claire',
      contentArg: 'nice post',
    });
    // The compatibility half, unchanged for a client that reads only these.
    expect(payload.title).toBe('Claire a commenté');
    expect(payload.body).toBe('nice post');
  });
});
