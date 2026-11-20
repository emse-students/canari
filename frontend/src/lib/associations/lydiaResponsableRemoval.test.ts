import { afterEach, describe, expect, it, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';

/**
 * A PLATFORM ADMIN REMOVING THE LYDIA RESPONSABLE (owner, 2026-11-20): the server's typed refusal,
 * then a confirmation TYPED by the admin, then the removal again with the acknowledgement. Anyone
 * else's refusal stands.
 */
const state = vi.hoisted(() => ({
  remove: vi.fn(),
  confirm: vi.fn(),
  answer: true,
}));

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  removeMember: state.remove,
}));

vi.mock('$lib/stores/confirm.svelte', () => ({
  showConfirm: (message: string, opts: unknown) => {
    state.confirm(message, opts);
    return Promise.resolve(state.answer);
  },
}));

import { LEAVE_REFUSAL, SocialApiError } from './api';
import { removeRosterMember } from './lydiaResponsableRemoval';

const ASSO = { id: 'asso-1', name: 'BDE' };
const mustHandOver = () => new SocialApiError('x', LEAVE_REFUSAL.RESPONSABLE_MUST_HAND_OVER, 409);

afterEach(() => {
  state.remove.mockReset();
  state.confirm.mockReset();
  state.answer = true;
  vi.restoreAllMocks();
});

describe('removeRosterMember', () => {
  it('an ordinary removal is sent once, no confirmation beyond the roster one', async () => {
    state.remove.mockResolvedValue({ ok: true });
    await expect(removeRosterMember(ASSO, 'u-1', false)).resolves.toBe('removed');
    expect(state.remove).toHaveBeenCalledTimes(1);
    expect(state.remove).toHaveBeenCalledWith('asso-1', 'u-1');
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('a manager removing the Responsable: the typed refusal stands, nothing asked again', async () => {
    state.remove.mockRejectedValue(mustHandOver());
    await expect(removeRosterMember(ASSO, 'u-resp', false)).rejects.toMatchObject({
      code: LEAVE_REFUSAL.RESPONSABLE_MUST_HAND_OVER,
    });
    expect(state.remove).toHaveBeenCalledTimes(1);
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('a platform admin TYPES the association name, then the removal is sent with the acknowledgement', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    state.remove.mockRejectedValueOnce(mustHandOver()).mockResolvedValueOnce({ ok: true });
    await expect(removeRosterMember(ASSO, 'u-resp', true)).resolves.toBe('removed');
    expect(state.confirm).toHaveBeenCalledWith(m.asso_member_lydia_responsable_admin_confirm(), {
      confirmLabel: m.asso_member_lydia_responsable_admin_confirm_button(),
      danger: true,
      requireText: 'BDE',
    });
    expect(state.remove).toHaveBeenLastCalledWith('asso-1', 'u-resp', {
      lydiaResponsableAcknowledged: true,
    });
  });

  it('a platform admin who does not confirm: nothing sent again, declined', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    state.answer = false;
    state.remove.mockRejectedValue(mustHandOver());
    await expect(removeRosterMember(ASSO, 'u-resp', true)).resolves.toBe('declined');
    expect(state.remove).toHaveBeenCalledTimes(1);
  });

  it('any other refusal is thrown as it was, even for a platform admin', async () => {
    const other = new SocialApiError('x', LEAVE_REFUSAL.LAST_MEMBER_MANAGER, 409);
    state.remove.mockRejectedValue(other);
    await expect(removeRosterMember(ASSO, 'u-1', true)).rejects.toBe(other);
    expect(state.confirm).not.toHaveBeenCalled();
  });
});
