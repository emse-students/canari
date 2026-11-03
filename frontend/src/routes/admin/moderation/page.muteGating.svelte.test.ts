// @vitest-environment happy-dom
/**
 * THE MUTE BUTTONS ARE DRAWN FROM THE SERVER'S ANSWER ALONE (2026-11-02): a BDE moderator mutes the
 * people of its own spaces only, and each report says so in `canMuteReporter` /
 * `canMuteReportedUser`. Only `true` draws the control - `false` draws none, as an absent field
 * would - so the queue never offers a mute the server would refuse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { ContentReport } from '$lib/moderation/api';

vi.mock('$app/state', () => ({
  page: { url: new URL('https://canari.test/admin/moderation'), params: {}, state: {} },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
// Nothing here talks to a server: the token every API module asks for is a constant.
vi.mock('$lib/stores/auth', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/auth')>()),
  getToken: () => Promise.resolve('token'),
}));
vi.mock('$lib/stores/user', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/user')>()),
  isGlobalAdmin: () => true,
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id,
  resolveUserDisplayName: (id: string) => Promise.resolve(id),
}));
const moderationApi = vi.hoisted(() => ({ listReports: vi.fn() }));
vi.mock('$lib/moderation/api', async (orig) => ({
  ...(await orig<typeof import('$lib/moderation/api')>()),
  ...moderationApi,
}));

import Page from './+page.svelte';

function report(canMuteReporter: boolean, canMuteReportedUser: boolean): ContentReport {
  return {
    id: 'r1',
    reporterId: 'reporter',
    contentType: 'user',
    contentId: 'author',
    reason: 'spam',
    details: null,
    status: 'pending',
    reviewedBy: null,
    reportedUserId: 'author',
    createdAt: '2026-11-02T10:00:00.000Z',
    contentPreview: 'Reported preview',
    postId: null,
    canMuteReporter,
    canMuteReportedUser,
  };
}

const mounted: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function openWith(r: ContentReport) {
  moderationApi.listReports.mockResolvedValueOnce([r]);
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  await vi.waitFor(() => expect(moderationApi.listReports).toHaveBeenCalled());
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

const buttonLabelled = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('the moderation queue mute buttons', () => {
  it('draws both when the server allows both', async () => {
    await openWith(report(true, true));
    await vi.waitFor(() => expect(buttonLabelled(m.moderation_muter_signaleur())).toBeDefined());
    expect(buttonLabelled(m.moderation_muter_auteur())).toBeDefined();
  });

  it('draws neither when the server refuses both', async () => {
    await openWith(report(false, false));
    // The report itself is drawn - only its mute controls are not.
    await vi.waitFor(() => expect(document.body.textContent).toContain('Reported preview'));
    expect(buttonLabelled(m.moderation_muter_signaleur())).toBeUndefined();
    expect(buttonLabelled(m.moderation_muter_auteur())).toBeUndefined();
  });

  it('draws each one from its own flag', async () => {
    await openWith(report(false, true));
    await vi.waitFor(() => expect(buttonLabelled(m.moderation_muter_auteur())).toBeDefined());
    expect(buttonLabelled(m.moderation_muter_signaleur())).toBeUndefined();
  });
});
