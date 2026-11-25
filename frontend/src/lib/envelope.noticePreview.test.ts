import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '$lib/paraglide/runtime';
import { getPreviewText, mkNoticeEnvelope, type NoticeSpec } from './envelope';
import { noticeText } from '$lib/utils/chat/noticeText';

const spec: NoticeSpec = { event: 'memberAdded', actor: 'u-a', targets: ['u-b'] };
const names: Record<string, string> = { 'u-a': 'Ana', 'u-b': 'Ben' };

describe('the list preview of a notice row', () => {
  afterEach(() => setLocale('fr', { reload: false }));

  it('is drawn from the ids in the reader language, not the writer-language stored sentence', () => {
    setLocale('en', { reload: false });
    const env = mkNoticeEnvelope('Ana a ajouté Ben au groupe', spec);
    const drawn = getPreviewText(env, (id) => names[id] ?? null);
    expect(drawn).toBe(noticeText(spec, (id) => names[id]));
    expect(drawn).toBe('Ana added Ben to the group');
  });

  it('keeps the stored sentence while a name is unknown, or with no resolver', () => {
    const env = mkNoticeEnvelope('stored', spec);
    expect(getPreviewText(env, () => null)).toBe('stored');
    expect(getPreviewText(env)).toBe('stored');
  });
});
