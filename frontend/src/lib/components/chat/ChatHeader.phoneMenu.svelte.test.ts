/**
 * THE PHONE HEADER IS BACK + A CENTRE PILL + A MENU THAT GROWS (user, 2026-09-30).
 *
 * The menu must offer exactly what the desktop row of icons offers, under the same conditions - a
 * channel's members, the media, the search, the settings, the calls only when their handlers are
 * given - or a phone would have fewer (or more) actions than the same conversation on a laptop.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { writable } from 'svelte/store';
import ChatHeader from './ChatHeader.svelte';

// The glass header is the PHONE APPS' (`usesGlassChrome`); the website keeps the classic one.
const chrome = vi.hoisted(() => ({ app: true }));
vi.mock('$lib/mobile/glassChrome', () => ({ usesGlassChrome: () => chrome.app }));

// The header resolves a DM's name, its avatar and its presence over the network; none is what this
// file is about, and unmocked they dial a server the test has not got.
vi.mock('$lib/stores/presenceStore', () => ({
  presenceMap: writable({}),
  watchUsers: () => {},
  unwatchUsers: () => {},
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (_id: string, fallback: string) => fallback,
  resolveUserDisplayName: async () => null,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
afterEach(() => {
  chrome.app = true;
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function mountHeader(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatHeader, {
    target,
    props: {
      contactName: 'u-1',
      displayName: 'BDE',
      isReady: true,
      onOpenMedia: vi.fn(),
      onToggleSearch: vi.fn(),
      onOpenSettings: vi.fn(),
      onBack: vi.fn(),
      ...props,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
}

/** The phone header's menu entries, in order. */
function openPhoneMenu(): string[] {
  const phone = document.querySelector('.chat-header-phone')!;
  (phone.querySelector('button[aria-label="Plus d\'actions"]') as HTMLButtonElement).click();
  flushSync();
  return [...document.querySelectorAll('[role="menu"] button')].map((b) => b.textContent!.trim());
}

describe('ChatHeader on the website', () => {
  it('draws the classic header only - no glass pieces, whatever the width', () => {
    chrome.app = false;
    mountHeader({ isGroupConversation: true });
    expect(document.querySelector('.chat-header-phone')).toBeNull();
    const header = document.querySelector('header')!;
    expect(header.classList.contains('hidden')).toBe(false);
    expect(document.querySelector('.glass-chrome')).toBeNull();
  });
});

describe('ChatHeader in the phone apps', () => {
  it('offers media, search and settings in a group', () => {
    mountHeader({ isGroupConversation: true });
    expect(openPhoneMenu()).toEqual(['Médias, liens et fichiers', 'Rechercher', 'Paramètres']);
  });

  it("puts a channel's members first, and marks them open when they are", () => {
    mountHeader({ isChannel: true, onOpenMembers: vi.fn(), membersActive: true });
    expect(openPhoneMenu()).toEqual([
      'Membres',
      'Médias, liens et fichiers',
      'Rechercher',
      'Paramètres',
    ]);
    const members = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(
      (b) => b.textContent?.trim() === 'Membres'
    );
    expect(members?.getAttribute('aria-checked')).toBe('true');
  });

  it('offers the calls only when their handlers are given - as the desktop row does', () => {
    mountHeader({
      isGroupConversation: false,
      onStartAudioCall: vi.fn(),
      onStartVideoCall: vi.fn(),
    });
    expect(openPhoneMenu().slice(0, 2)).toEqual(['Appel audio', 'Appel vidéo']);
  });

  it("opens the conversation's settings from the centre pill", () => {
    const onOpenSettings = vi.fn();
    mountHeader({ isGroupConversation: true, onOpenSettings });
    const pill = document.querySelector<HTMLButtonElement>(
      '.chat-header-phone button[aria-label="Paramètres du groupe"]'
    )!;
    pill.click();
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
