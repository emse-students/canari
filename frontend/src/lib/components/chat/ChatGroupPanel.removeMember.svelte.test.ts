// @vitest-environment happy-dom
/**
 * A REMOVAL REMOVES THE MEMBER WHOSE ROW WAS TAPPED, EVEN WHEN THE ROSTER MOVES.
 *
 * On the `1.7.0-alpha.9` bench a removal aimed at beta removed alpha, four times out of four: the
 * roster listed beta while alpha's profile lookup was still in flight, alpha's row was then inserted
 * ABOVE beta's (family-name order), and the tap at the place beta's remove control had just been
 * landed on alpha's. The remove controls are now dead while any lookup is pending - the order is not
 * final until the last one settles - and each control carries its own member's id.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

type Parts = { firstName: string | null; lastName: string | null; displayName: string | null };
const lookups = vi.hoisted(() => ({
  pending: new Map<string, (parts: Parts) => void>(),
}));

vi.mock('$lib/stores/user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/user')>()),
  fetchUserProfile: (id: string) =>
    new Promise<Parts>((resolve) => {
      lookups.pending.set(id, resolve);
    }),
}));
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  getUserDisplayNameSync: (id: string, fallback?: string) => fallback ?? id,
  resolveUserDisplayName: async () => null,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));

import ChatGroupPanel from './ChatGroupPanel.svelte';

const person = (firstName: string, lastName: string): Parts => ({
  firstName,
  lastName,
  displayName: `${firstName} ${lastName}`,
});

/** Answers one member's profile lookup, then lets the ordered list re-render. */
async function answer(id: string, parts: Parts) {
  const resolve = lookups.pending.get(id);
  expect(resolve, `a lookup for ${id} was asked`).toBeDefined();
  lookups.pending.delete(id);
  resolve!(parts);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  flushSync();
}

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  lookups.pending.clear();
  document.body.innerHTML = '';
});

const removeButtons = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button[data-remove-member]')].map((b) => ({
    member: b.dataset.removeMember,
    disabled: b.disabled,
    el: b,
  }));

describe('ChatGroupPanel remove control', () => {
  it('is dead while a member is still to be inserted, and removes the member of its own row once the order is final', async () => {
    const onRemoveMember = vi.fn();
    const c = mount(ChatGroupPanel, {
      target: document.body,
      props: {
        effectiveDisplayName: 'Team',
        contactName: 'team',
        isGroupConversation: true,
        currentUserId: 'me',
        groupId: 'g1',
        groupMembers: ['me', 'beta', 'alpha'],
        onClose: () => {},
        onRemoveMember,
      },
    });
    mounted.push(() => void unmount(c));
    await tick();
    flushSync();

    // beta (and the reader) are listed; alpha's lookup is still in flight.
    await answer('me', person('Me', 'MOI'));
    await answer('beta', person('Beta', 'BETA'));
    const whileSettling = removeButtons();
    expect(whileSettling.map((b) => b.member)).toEqual(['beta']);
    // THE OLD CODE FAILS HERE: the control was live, at a place alpha's row is about to take.
    expect(whileSettling[0].disabled).toBe(true);

    // alpha settles and is inserted ABOVE beta: the first remove control is now alpha's.
    await answer('alpha', person('Alpha', 'ALPHA'));
    const settled = removeButtons();
    expect(settled.map((b) => b.member)).toEqual(['alpha', 'beta']);
    expect(settled.every((b) => !b.disabled)).toBe(true);

    // beta's own control removes beta - the id it carries, never a position.
    settled.find((b) => b.member === 'beta')!.el.click();
    expect(onRemoveMember).toHaveBeenCalledTimes(1);
    expect(onRemoveMember).toHaveBeenCalledWith('beta');
  });
});
