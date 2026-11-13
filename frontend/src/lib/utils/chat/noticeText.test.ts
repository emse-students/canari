import { describe, expect, it } from 'vitest';
import { noticeDisplayText, noticeText } from './noticeText';
import { mkNoticeEnvelope, parseEnvelope, serializeEnvelope, type NoticeSpec } from '$lib/envelope';

const spec: NoticeSpec = { event: 'memberAdded', actor: 'u-a', targets: ['u-b', 'u-c'] };
const names: Record<string, string> = { 'u-a': 'Ana', 'u-b': 'Ben', 'u-c': 'Cleo' };

describe('the sentence a notice row shows (review of #3232)', () => {
  it('draws from the ids once every name is known', () => {
    const drawn = noticeDisplayText(spec, 'stored', (id) => names[id] ?? null);
    expect(drawn).toBe(noticeText(spec, (id) => names[id]));
    expect(drawn).toContain('Ben');
  });

  it('keeps the stored sentence while any name is unknown here', () => {
    expect(noticeDisplayText(spec, 'stored', (id) => (id === 'u-c' ? null : names[id]))).toBe(
      'stored'
    );
  });
});

describe('a stored notice read back', () => {
  it('round-trips, and an older reader still has the sentence as `text`', () => {
    const env = parseEnvelope(serializeEnvelope(mkNoticeEnvelope('Ana a ajouté Ben', spec)));
    expect(env).toMatchObject({ kind: 'system', text: 'Ana a ajouté Ben', notice: spec });
  });

  it('drops a notice that names nobody it acted upon, leaving the sentence', () => {
    for (const targets of [undefined, [], [''], [3]]) {
      const raw = JSON.stringify({
        kind: 'system',
        text: 'frozen',
        notice: { event: 'memberRemoved', actor: 'u-a', targets },
      });
      const env = parseEnvelope(raw);
      expect(env).toEqual({ kind: 'system', text: 'frozen' });
    }
  });
});
