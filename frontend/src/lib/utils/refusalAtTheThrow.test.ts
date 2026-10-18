import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({
  socialUrl: () => 'https://social.test',
  coreUrl: () => 'https://core.test',
  deliveryUrl: () => 'https://delivery.test',
}));

import { refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
import { openAdminerSession } from '$lib/admin/adminerSession';
import { fetchVaultCiphertext } from '$lib/associations/vaultDownload';
import { fetchMinesweeperLeaderboard, submitMinesweeperChallenge } from '$lib/minesweeper/api';
import { acceptGroupInvite, createGroupInvite, getGroupInvitePreview } from '$lib/mls/groupInvites';

/** Every refused call of these endpoints throws a typed refusal: status always, code when sent. */
const answer = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => apiFetch.mockReset());

describe('refusals are typed at the throw', () => {
  it.each([
    ['minesweeper submit', () => submitMinesweeperChallenge('c', [], 1)],
    ['minesweeper leaderboard', () => fetchMinesweeperLeaderboard()],
    ['invite creation', () => createGroupInvite('g')],
    ['invite preview', () => getGroupInvitePreview('t')],
    ['invite accept', () => acceptGroupInvite('t')],
    ['adminer session', () => openAdminerSession()],
    ['vault download', () => fetchVaultCiphertext('m')],
  ])('%s carries the status and the code', async (_name, call) => {
    apiFetch.mockResolvedValue(answer(429, { code: 'SLOW_DOWN', message: 'English prose' }));
    const e = await call().catch((x: unknown) => x);
    expect(refusalStatus(e)).toBe(429);
    expect(refusalCode(e)).toBe('SLOW_DOWN');
  });

  it('a refusal without a code has none, and a non-JSON body does not break the throw', async () => {
    apiFetch.mockResolvedValue(new Response('<html>', { status: 500 }));
    const e = await acceptGroupInvite('t').catch((x: unknown) => x);
    expect(refusalStatus(e)).toBe(500);
    expect(refusalCode(e)).toBeNull();
  });
});
