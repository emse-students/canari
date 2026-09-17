/**
 * EVERY TEST FILE STARTS IN THE BASE LOCALE, BECAUSE THE LOCALE IS GLOBAL AND SOME FILES MOVE IT.
 *
 * Paraglide keeps ONE locale for the process. Nine test files set it on purpose - `fileSize` ends on
 * `en` to check a thousands separator, `bottomNavNames` sweeps every locale - and none of them owes
 * the next file a restore, because nothing said they did. Meanwhile two files ASSERT French output
 * without ever asking for it: `feedEvents` expects `18:30` rather than `06:30 PM`, and
 * `MessageBubbleToolbar.placement` finds the overflow button by its French `aria-label`. Whether
 * those two pass therefore depended on what else had run in the same worker first.
 *
 * It was not theoretical: 14 assertions failed on this machine on 2026-09-17 and passed on Linux CI
 * from the same commit, which is the worst shape a suite can have - green where nobody is looking at
 * it, red where somebody is. Forcing the locale to `en` reproduces all 14 verbatim, which is what
 * named the cause; nothing about load or timing was involved.
 *
 * So the locale is SET rather than overwritten. `overwriteGetLocale` would replace the getter and
 * silently defeat the files that legitimately move the locale afterwards - their `setLocale` would
 * write a value `getLocale` no longer reads. `setLocale` leaves that door open, which is the whole
 * point: this pins a STARTING POINT, not a value.
 */
import { beforeEach } from 'vitest';
import { baseLocale, setLocale } from '$lib/paraglide/runtime';

beforeEach(() => {
  setLocale(baseLocale, { reload: false });
});
