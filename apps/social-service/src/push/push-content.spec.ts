import {
  mentionContent,
  replyContent,
  commentContent,
  reactionContent,
  formOpeningSoonContent,
  formOpenContent,
  eventProposedContent,
  eventValidatedContent,
  eventRejectedContent,
  eventUpdatedContent,
  eventDeletedContent,
  associationPostContent,
  followedPostContent,
  previewOf,
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
    ['eventProposed', eventProposedContent('Claire', 'Soiree BDE')],
    ['eventValidated', eventValidatedContent('Claire', 'Soiree BDE')],
    ['eventRejected', eventRejectedContent('Claire', 'Soiree BDE')],
    ['eventUpdated', eventUpdatedContent('Claire', 'Soiree BDE')],
    ['eventDeleted', eventDeletedContent('Claire', 'Soiree BDE')],
    ['associationPost', associationPostContent('BDE', 'hello')],
    ['followedPost', followedPostContent('Claire', 'hello')],
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

describe('previewOf', () => {
  /**
   * The one piece of a push that is the USER's words rather than ours, so the only rule is that a
   * lock screen gets an opening and not a whole post. It was inline in the comment path and
   * became shared the day publications needed the same cut.
   */
  it('leaves a short text exactly as it was typed', () => {
    expect(previewOf('hello')).toBe('hello');
  });

  it('cuts a long text to the same length whatever it says', () => {
    // Ellipsed to the limit INCLUDING the ellipsis: a preview that grew by one character past the
    // bound when it was truncated would be longer than the text it replaced at the boundary.
    const cut = previewOf('x'.repeat(200));
    expect(cut).toHaveLength(60);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('does not ellipse a text that exactly fits', () => {
    expect(previewOf('y'.repeat(60))).toBe('y'.repeat(60));
  });

  it('trims first, so surrounding blank lines do not spend the budget', () => {
    expect(previewOf('  hello\n\n')).toBe('hello');
  });

  it('gives an empty string for an empty post, rather than inventing a sentence', () => {
    // An images-only post has no text. The SENTENCE for that case belongs to the native table,
    // which is the one layer that knows the reader's language.
    expect(previewOf('')).toBe('');
    expect(previewOf('   ')).toBe('');
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

/**
 * THE SERVER'S SENTENCE AND THE PHONE'S SENTENCE ARE TWO COPIES OF ONE SENTENCE.
 *
 * `legacyTitle`/`legacyBody` are what a client too old to compose from a key is sent; the Android
 * resources are what every other client renders. They are the same sentence written twice, and
 * until 2026-09-09 nothing compared them - which let two divergences ship together in one feature.
 *
 * Both were read off the glass rather than caught here. The agenda's five pairs went into
 * `values/strings.xml` with their ACCENTS STRIPPED, and the loss changed the word: `valide` is an
 * adjective where `valide` with its acute is a participle, and the same for refuse and modifie. In
 * the same file the two FORM pairs were still English on the legacy side while the resource beside
 * them had been French for weeks, so exactly the oldest clients got the one language the app does
 * not speak. Neither is visible to a compiler, to `nativeStrings.test.ts` - which holds the two
 * RESOURCE files against each other and never sees this file - or to the tests above, which assert
 * that a key travels and never what it says.
 *
 * So this compares the pair. It is the rule this repository already states about any two copies of
 * one fact: derive it, or let a test compare them.
 */
describe('the legacy sentence and the Android resource say the same thing', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolve } = require('node:path') as typeof import('node:path');

  const STRINGS_FR = resolve(
    __dirname,
    '../../../../frontend/src-tauri/gen/android/app/src/main/res/values/strings.xml'
  );

  /** Android escapes an apostrophe and a quote with a backslash; this undoes exactly those.
   *  Two characters, not one: in a pattern a single backslash would escape the group instead. */
  const ANDROID_ESCAPE = new RegExp(String.fromCharCode(92, 92) + '([\'"])', 'g');

  /** Every `<string name="x">value</string>`, with those escapes undone. */
  function androidStrings(): Map<string, string> {
    const source = readFileSync(STRINGS_FR, 'utf8');
    const out = new Map<string, string>();
    for (const m of source.matchAll(/<string name="([^"]+)"\s*>([\s\S]*?)<\/string>/g)) {
      out.set(m[1], m[2].replace(ANDROID_ESCAPE, '$1'));
    }
    return out;
  }

  // Sentinels rather than plausible values: a name that could occur in a sentence would be
  // substituted inside the prose too, and the comparison would pass on a sentence nobody wrote.
  const ACTOR = '\u0001ACTOR\u0001';
  const ARG = '\u0001ARG\u0001';

  // EVERY placeholder collapses to one token, and the INDEX is deliberately not compared. The
  // four "the BDE did it" strings take the event title as their only argument, so it is the
  // FIRST there and the second in `proposed`, which names an actor before it - both correct, and
  // a test reading the first slot as "the actor" would fail all four for being right. What this
  // compares is the SENTENCE. That the arguments line up is a different contract, and it already
  // has a test: `nativeStrings.test.ts`, "keeps the same format arguments in both languages".
  const SLOT = '{}';
  const slot = (s: string) => s.split(ACTOR).join(SLOT).split(ARG).join(SLOT);
  const ANDROID_SLOT = new RegExp('%' + String.fromCharCode(92) + 'd[$]s', 'g');
  const androidSlot = (s: string) => s.replace(ANDROID_SLOT, SLOT);

  // The three social bodies are the author's OWN text when there is any, and that is data rather
  // than prose - so they are compared in the form the resource actually states, with no preview.
  const PAIRS: [string, PushContent][] = [
    ['social_mention', mentionContent(ACTOR, '')],
    ['social_reply', replyContent(ACTOR, '')],
    ['social_comment', commentContent(ACTOR, '')],
    ['social_reaction', reactionContent(ACTOR, ARG)],
    ['form_opening_soon', formOpeningSoonContent()],
    ['form_open', formOpenContent()],
    ['event_proposed', eventProposedContent(ACTOR, ARG)],
    ['event_validated', eventValidatedContent(ACTOR, ARG)],
    ['event_rejected', eventRejectedContent(ACTOR, ARG)],
    ['event_updated', eventUpdatedContent(ACTOR, ARG)],
    ['event_deleted', eventDeletedContent(ACTOR, ARG)],
    ['social_association_post', associationPostContent(ACTOR, '')],
    ['social_followed_post', followedPostContent(ACTOR, '')],
  ];

  /**
   * EVERY KEY IN THE UNION IS IN THE LIST ABOVE, and until 2026-09-10 nothing said so.
   *
   * The list was hand-maintained, so a key added to `PushContentKey` with a builder and no entry
   * here was compared against nothing - it would pass this whole block by being absent from it.
   * `nativeStrings.test.ts` reads the union from source for exactly this reason; this does the
   * same, and the two now fail on the same omission from opposite sides.
   */
  it('compares every key the union declares, with none left out of the list', () => {
    const source = readFileSync(resolve(__dirname, 'push-content.ts'), 'utf8');
    const union = source.match(/export type PushContentKey =([\s\S]*?);/);
    const declared = [...(union?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    expect(declared.length).toBeGreaterThan(3);
    expect(declared.filter((key) => !PAIRS.some(([k]) => k === key))).toEqual([]);
  });

  it('has a resource for every key a builder emits', () => {
    const fr = androidStrings();
    const missing = PAIRS.flatMap(([key]) =>
      [`notif_${key}_title`, `notif_${key}_body`].filter((name) => !fr.has(name))
    );

    expect(missing).toEqual([]);
  });

  it.each(PAIRS)('%s reads the same on an old client and a current one', (key, content) => {
    const fr = androidStrings();

    // ONE assertion over both halves rather than two: `expect` takes no message under Jest, so
    // a label there is silently dropped, and the diff of a whole pair names the key by itself.
    expect({ title: slot(content.legacyTitle), body: slot(content.legacyBody) }).toEqual({
      title: androidSlot(fr.get(`notif_${key}_title`) ?? ''),
      body: androidSlot(fr.get(`notif_${key}_body`) ?? ''),
    });
  });
});
