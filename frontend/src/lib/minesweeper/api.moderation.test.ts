/**
 * MINESWEEPER MODERATION, FROM THE CLIENT (user, 2026-10-02): remove a score, ban a user, lift a ban.
 *
 * Pinned: each call hits the route the server exposes with the method it expects, an id is encoded
 * rather than spliced into the path, a refusal is an error (never a silent success), and a 403 on
 * starting a ranked game is the TYPED `MinesweeperBannedError` - the modal tells a banned player so
 * by that type, never by reading a message.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ socialUrl: () => '' }));

import {
  banMinesweeperUser,
  fetchMinesweeperBans,
  MinesweeperBannedError,
  removeMinesweeperScore,
  startMinesweeperChallenge,
  unbanMinesweeperUser,
} from './api';

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });
const refused = (status: number) => new Response('', { status });

beforeEach(() => apiFetch.mockReset());

describe('minesweeper moderation client', () => {
  it('removes a score with DELETE on its id', async () => {
    apiFetch.mockResolvedValue(ok());
    await removeMinesweeperScore('3f2c-uuid');
    expect(apiFetch).toHaveBeenCalledWith('/api/minesweeper/scores/3f2c-uuid', {
      method: 'DELETE',
    });
  });

  it('bans with a POST carrying the user and the reason, and no reason key when there is none', async () => {
    apiFetch.mockResolvedValue(ok());
    await banMinesweeperUser('mallory', 'cheating');
    expect(apiFetch).toHaveBeenLastCalledWith('/api/minesweeper/bans', {
      method: 'POST',
      body: JSON.stringify({ userId: 'mallory', reason: 'cheating' }),
    });
    await banMinesweeperUser('mallory');
    expect(apiFetch).toHaveBeenLastCalledWith('/api/minesweeper/bans', {
      method: 'POST',
      body: JSON.stringify({ userId: 'mallory' }),
    });
  });

  it('encodes an id that is not path-safe instead of splicing it in', async () => {
    apiFetch.mockResolvedValue(ok());
    await unbanMinesweeperUser('a/b c');
    expect(apiFetch).toHaveBeenCalledWith('/api/minesweeper/bans/a%2Fb%20c', { method: 'DELETE' });
  });

  it('lists the bans', async () => {
    const bans = [
      { userId: 'm', displayName: 'Mallory', reason: null, bannedBy: 'a', bannedAt: '2026-10-02' },
    ];
    apiFetch.mockResolvedValue(ok({ bans }));
    expect(await fetchMinesweeperBans()).toEqual(bans);
  });

  it.each([
    ['remove', () => removeMinesweeperScore('x')],
    ['ban', () => banMinesweeperUser('x')],
    ['unban', () => unbanMinesweeperUser('x')],
    ['list', () => fetchMinesweeperBans()],
  ])('a refused %s is an error, never a silent success', async (_, act) => {
    apiFetch.mockResolvedValue(refused(403));
    await expect(act()).rejects.toThrow('403');
  });

  it('a 403 on starting a ranked game is the typed banned error', async () => {
    apiFetch.mockResolvedValue(refused(403));
    await expect(startMinesweeperChallenge()).rejects.toBeInstanceOf(MinesweeperBannedError);
  });

  it('any other failure to start stays a plain error', async () => {
    apiFetch.mockResolvedValue(refused(500));
    const err = await startMinesweeperChallenge().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MinesweeperBannedError);
  });
});
