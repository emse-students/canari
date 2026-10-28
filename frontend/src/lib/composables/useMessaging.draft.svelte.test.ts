/**
 * EACH CONVERSATION KEEPS ITS OWN DRAFT (Mi 9T, 2026-10-27). The composer's text was one field for
 * every conversation: a draft left in A, or a share staged there, sat in B's composer after a
 * switch, and B's Send posted it there. The text now follows the rule of the staged files and the
 * armed reply - keyed by conversation, forgotten at sign-out.
 */
import { describe, expect, it, vi } from 'vitest';
import { useMessaging } from './useMessaging.svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

// The sign-out counter, moved by hand: a sign-out begins by bumping it (`clearAuthCounted`).
const signOut = vi.hoisted(() => ({ count: 0 }));
vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/auth')>()),
  signOutGeneration: () => signOut.count,
}));

// Imported once: every `useMessaging()` call builds its own maps, so no module reset is needed.

async function freshMessaging() {
  return useMessaging();
}

describe('the composer draft', () => {
  it('belongs to the conversation it was typed in', async () => {
    const messaging = await freshMessaging();
    messaging.setDraft('A', 'for A only');

    expect(messaging.draftFor('A')).toBe('for A only');
    expect(messaging.draftFor('B')).toBe('');
  });

  it('is empty with no conversation open, and nothing typed there is kept', async () => {
    const messaging = await freshMessaging();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    messaging.setDraft(null, 'lost');

    expect(messaging.draftFor(null)).toBe('');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('is cleared by an empty text', async () => {
    const messaging = await freshMessaging();
    messaging.setDraft('A', 'typed');
    messaging.setDraft('A', '');

    expect(messaging.draftFor('A')).toBe('');
  });

  it("is forgotten at sign-out, so the next account's same conversation starts empty", async () => {
    const messaging = await freshMessaging();
    messaging.setDraft('shared-dm', 'from the account leaving');

    messaging.forgetAccount(vi.fn());

    expect(messaging.draftFor('shared-dm')).toBe('');
  });

  it('comes back LATER into the conversation it was written in (an edit, a refused send)', async () => {
    const messaging = await freshMessaging();
    const giveBack = messaging.lateDraftWriter('A', 'draft an edit replaced');
    messaging.setDraft('B', 'typed in B meanwhile');

    giveBack('hello');

    expect(messaging.draftFor('A')).toBe('hello');
    expect(messaging.draftFor('B')).toBe('typed in B meanwhile');
  });

  it('written back after a sign-out writes NOTHING - the next account would open it', async () => {
    // The order a sign-out takes: the counter moves, the drafts are forgotten, then the still
    // mounted composer resets its edit (or a refused send answers) and gives its text back.
    const messaging = await freshMessaging();
    const giveBack = messaging.lateDraftWriter('shared-dm', 'draft an edit replaced');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    signOut.count++;
    messaging.forgetAccount(vi.fn());

    giveBack('from the account leaving');

    expect(messaging.draftFor('shared-dm')).toBe('');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('dropped - signed out since'));
    expect(info.mock.calls.flat().join(' ')).not.toContain('from the account leaving');
    info.mockRestore();
  });
});
