// @vitest-environment happy-dom
import { flushSync } from 'svelte';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { APP_FOREGROUND_EVENT } from '$lib/utils/appForeground';
import {
  noteResumeOpening,
  notePageTapsUnroutable,
  PAGE_NOTIFICATION_OPENING,
  resumeOpeningHolds,
} from './resumeOpening.svelte';

/**
 * A SESSION WHOSE PAGE-NOTIFICATION LISTENER COULD NOT BE ARMED NEVER HOLDS ON A PAGE TAP (review
 * F2). Its own file: the latch is session-wide by design, and would leak into every other page-tap
 * test of `resumeOpening.svelte.test.ts`.
 */

function announce(foreground: boolean) {
  (window as unknown as Record<string, unknown>).__canariForeground = foreground;
  window.dispatchEvent(
    new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground, opening: null } })
  );
  flushSync();
}
const resolve = (id: string) => `dm:${id}`;

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__canariForeground;
});

it('a registration refused AFTER the edge releases the landing hold it left waiting', () => {
  announce(true);
  announce(false);
  notifNav.clear();
  noteResumeOpening(PAGE_NOTIFICATION_OPENING, 'dm:x', resolve);
  expect(resumeOpeningHolds('dm:x')).toBe(true);
  notePageTapsUnroutable('the listener registration was refused');
  expect(resumeOpeningHolds('dm:x')).toBe(false);
});

it('once unroutable, a later page tap resume holds nothing at all', () => {
  announce(true);
  announce(false);
  noteResumeOpening(PAGE_NOTIFICATION_OPENING, 'dm:x', resolve);
  expect(resumeOpeningHolds('dm:x')).toBe(false);
});
