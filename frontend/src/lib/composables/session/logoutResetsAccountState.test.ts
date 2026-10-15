import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Source guard on what sign-out forgets of the account leaving the tab. `endSessionImpl` runs over the
 * same dozen module-level dependencies `offlineUnlock.test.ts` describes, so the call is pinned in
 * the source rather than through a harness that would assert its own mocks.
 *
 * `resetAnnouncementState` had no caller (found 2026-10-12): the store's once-per-opening latch
 * stayed set, so a second account signing in in the same tab was never asked for its own
 * announcement and could be shown the first account's. Its behaviour is tested in
 * `stores/announcement.test.ts`; this pins that sign-out runs it.
 */
// THROUGH A PARAMETER, NOT A LITERAL: Vite rewrites `new URL('<literal>', import.meta.url)` into a
// served `http:` asset URL, which `fileURLToPath` refuses.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const sessionAuth = read('./sessionAuth.ts');

describe('sign-out forgets the account that left', () => {
  it('resets the announcement state', () => {
    const logout = sessionAuth.slice(sessionAuth.indexOf('export function endSessionImpl'));
    expect(logout).toContain('resetAnnouncementState();');
  });
});
