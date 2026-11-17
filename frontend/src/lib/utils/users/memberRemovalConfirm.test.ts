/**
 * THE REMOVAL DIALOG NAMES THE MEMBER IT REMOVES.
 *
 * It used to say "this member", so a tap that landed on the wrong row (1.7.0-alpha.9: a removal
 * aimed at beta removed alpha, 4/4) was confirmed without the person being told whose removal it
 * was. Every remove-a-member path asks through `confirmMemberRemoval`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const confirm = vi.hoisted(() => ({
  showConfirm: vi.fn(async (_message: string, _opts?: { danger?: boolean }) => true),
}));
const names = vi.hoisted(() => ({
  resolved: new Map<string, string | null>(),
  nicknames: new Map<string, string>(),
}));

vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: confirm.showConfirm }));
vi.mock('./displayName', () => ({
  resolveUserDisplayName: async (id: string) => names.resolved.get(id) ?? null,
  getUserDisplayNameSync: (id: string, fallback?: string, scope?: string) =>
    (scope ? names.nicknames.get(`${scope}:${id}`) : undefined) ?? fallback ?? id,
}));

import { m } from '$lib/paraglide/messages';
import { confirmMemberRemoval } from './memberRemovalConfirm';

beforeEach(() => {
  confirm.showConfirm.mockClear();
  names.resolved.clear();
  names.nicknames.clear();
});

describe('confirmMemberRemoval', () => {
  it.each([
    ['chat_community_remove_member_confirm', m.chat_community_remove_member_confirm],
    ['chat_group_remove_member_confirm', m.chat_group_remove_member_confirm],
    ['chat_channel_remove_access_confirm', m.chat_channel_remove_access_confirm],
    ['asso_member_remove_confirm', m.asso_member_remove_confirm],
  ] as const)('%s names the member being removed', async (_key, message) => {
    names.resolved.set('beta', 'Beta BETA');

    expect(await confirmMemberRemoval('beta', message)).toBe(true);

    const [text, opts] = confirm.showConfirm.mock.calls[0];
    expect(text).toContain('Beta BETA');
    expect(text).toBe(message({ member: 'Beta BETA' }));
    expect(opts?.danger).toBe(true);
  });

  it("names the member as the group's row draws them: its nickname there", async () => {
    names.resolved.set('beta', 'Beta BETA');
    names.nicknames.set('g1:beta', 'Bebe');

    await confirmMemberRemoval('beta', m.chat_group_remove_member_confirm, 'g1');

    expect(confirm.showConfirm.mock.calls[0][0]).toBe(
      m.chat_group_remove_member_confirm({ member: 'Bebe' })
    );
  });

  it('names the id, and says so at warn, when no name is known - never "this member"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await confirmMemberRemoval('usr_beta', m.chat_community_remove_member_confirm);

    expect(confirm.showConfirm.mock.calls[0][0]).toContain('usr_beta');
    expect(warn.mock.calls.some(([l]) => String(l).includes('[REMOVE_MEMBER]'))).toBe(true);
    warn.mockRestore();
  });

  it('answers the person: a cancelled dialog removes nobody', async () => {
    confirm.showConfirm.mockResolvedValueOnce(false);
    expect(await confirmMemberRemoval('beta', m.chat_community_remove_member_confirm)).toBe(false);
  });
});
