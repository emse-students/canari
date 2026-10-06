/**
 * THE SUBSCRIBE MODAL ORDERS WHAT WORKS ON THE PLATFORM READING IT.
 *
 * The button was hidden on phones for four months on the premise that no phone opens `webcal:`.
 * That is false on an iPhone and true on the Mi 9T (measured 2026-10-01: no activity resolves
 * either scheme). So a phone gets the calendar-app link first AND the URL to copy, visible - and a
 * phone whose OS refuses the link is told so instead of watching a button that did nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const runtimeOs = vi.hoisted(() => ({ value: 'android' }));
const navigateExternal = vi.hoisted(() => vi.fn());

vi.mock('$lib/mls-client/mlsPlatform', () => ({
  detectRuntimeDeviceOs: () => runtimeOs.value,
}));
vi.mock('$lib/utils/openExternal', () => ({
  navigateExternal: (...args: unknown[]) => navigateExternal(...args),
}));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import CalendarSubscribeModal from './CalendarSubscribeModal.svelte';

const FEED = 'https://canari.emse.fr/api/associations/calendar/feed.ics';
const mounted: ReturnType<typeof mount>[] = [];

function render(extra: { signing?: 'idle' | 'signing' | 'ready' | 'error'; icsUrl?: string } = {}) {
  const component = mount(CalendarSubscribeModal, {
    target: document.body,
    props: { open: true, onClose: () => {}, icsUrl: FEED, intro: 'intro', ...extra },
  });
  mounted.push(component);
  flushSync();
}

/** The sections in the order a reader meets them. */
function sectionOrder(): string[] {
  return [...document.querySelectorAll('[data-subscribe-section]')].map(
    (el) => (el as HTMLElement).dataset.subscribeSection ?? ''
  );
}

function appButton(): HTMLButtonElement {
  const labels: string[] = [
    m.calendar_subscribe_app_button(),
    m.asso_calendar_apple_subscribe_button(),
  ];
  const button = [...document.querySelectorAll('button')].find((b) =>
    labels.includes(b.textContent?.trim() ?? '')
  );
  if (!button) throw new Error('no calendar-app button');
  return button as HTMLButtonElement;
}

beforeEach(() => {
  setLocale('en', { reload: false });
  navigateExternal.mockReset();
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

describe('CalendarSubscribeModal', () => {
  it('puts the calendar app first and the link to copy in view on a phone', () => {
    runtimeOs.value = 'android';
    render();
    expect(sectionOrder()).toEqual(['app', 'copy', 'google']);
    const input = document.querySelector('[data-subscribe-section="copy"] input');
    expect((input as HTMLInputElement).value).toBe(FEED);
  });

  it('warns that links saved before the signature stopped working (2026-10-06)', () => {
    runtimeOs.value = 'windows';
    render();
    expect(document.querySelector('[data-subscribe-old-links]')?.textContent?.trim()).toBe(
      m.calendar_subscribe_old_links_notice()
    );
    expect(document.querySelector('[data-subscribe-sign-failed]')).toBeNull();
  });

  it('says it is preparing the link, then that the server refused to sign it', () => {
    runtimeOs.value = 'windows';
    render({ signing: 'signing', icsUrl: '' });
    expect(document.querySelector('[data-subscribe-signing]')).not.toBeNull();
    unmount(mounted.pop()!);
    document.body.innerHTML = '';
    render({ signing: 'error', icsUrl: '' });
    expect(document.querySelector('[data-subscribe-sign-failed]')?.textContent?.trim()).toBe(
      m.calendar_subscribe_sign_failed()
    );
    expect(document.querySelector('[data-subscribe-signing]')).toBeNull();
  });

  it('keeps the desktop order: Google first, the calendar app last', () => {
    runtimeOs.value = 'windows';
    render();
    expect(sectionOrder()).toEqual(['google', 'app']);
  });

  it('hands iOS the webcal link and Android the webcals one', async () => {
    navigateExternal.mockResolvedValue(undefined);
    runtimeOs.value = 'ios';
    render();
    appButton().click();
    await vi.waitFor(() =>
      expect(navigateExternal).toHaveBeenCalledWith(
        'webcal://canari.emse.fr/api/associations/calendar/feed.ics'
      )
    );
    unmount(mounted.pop()!);
    document.body.innerHTML = '';

    runtimeOs.value = 'android';
    render();
    appButton().click();
    await vi.waitFor(() =>
      expect(navigateExternal).toHaveBeenLastCalledWith(
        'webcals://canari.emse.fr/api/associations/calendar/feed.ics'
      )
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('says so when the OS refuses the link, as Android does with no handler', async () => {
    runtimeOs.value = 'android';
    navigateExternal.mockRejectedValue(new Error('No Activity found to handle Intent'));
    render();
    appButton().click();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        m.calendar_subscribe_app_none()
      )
    );
  });
});
