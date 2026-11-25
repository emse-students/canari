import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '$lib/paraglide/runtime';

const known: Record<string, string> = { 'u-a': 'Ana', 'u-b': 'Ben' };
const resolve = vi.hoisted(() => vi.fn(async (_id: string) => null as string | null));
vi.mock('$lib/utils/users/displayName', () => ({
  peekUserDisplayName: (id: string) => known[id] ?? null,
  resolveUserDisplayName: resolve,
  getUserDisplayNameSync: (id: string) => known[id] ?? id,
}));

import { getPreviewText, mkNoticeEnvelope, type NoticeSpec } from './envelope';
import { Log } from '$lib/utils/Log';

const spec: NoticeSpec = { event: 'memberAdded', actor: 'u-a', targets: ['u-b'] };

describe('the preview of a notice row, whichever caller asks', () => {
  beforeEach(() => resolve.mockClear());
  afterEach(() => {
    setLocale('fr', { reload: false });
    vi.restoreAllMocks();
  });

  it('is drawn from the ids in the reader language with NO resolver passed', () => {
    setLocale('en', { reload: false });
    const env = mkNoticeEnvelope('Ana a ajouté Ben au groupe', spec);
    expect(getPreviewText(env)).toBe('Ana added Ben to the group');
  });

  it('is a PURE draw: many notices with unknown ids cost no fetch and no log', () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => undefined);
    for (let n = 0; n < 200; n++) {
      const env = mkNoticeEnvelope(`stored ${n}`, { ...spec, targets: [`u-new-${n}`] });
      expect(getPreviewText(env)).toBe(`stored ${n}`);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
