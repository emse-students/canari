/**
 * EACH CONVERSATION KEEPS ITS OWN DRAFT (Mi 9T, 2026-10-27). The composer's text was one field for
 * every conversation: a draft left in A, or a share staged there, sat in B's composer after a
 * switch, and B's Send posted it there. The text now follows the rule of the staged files and the
 * armed reply - keyed by conversation, forgotten at sign-out.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

// Imported once: every `useMessaging()` call builds its own maps, so no module reset is needed.
const { useMessaging } = await import('./useMessaging.svelte');

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
});
