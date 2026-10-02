import { apiFetch } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';
import type { MinesweeperConfig, MinesweeperMove } from './game';

export interface MinesweeperChallengeResponse {
  challengeId: string;
  seed: string;
  config: MinesweeperConfig;
  startedAt: string;
  expiresAt: string;
  serverNow: string;
}

export interface MinesweeperSubmitResponse {
  accepted: boolean;
  durationMs: number;
  /** Raw server wall-clock (challenge create → submit arrival); for debugging. */
  serverDurationMs?: number;
  moveCount: number;
  personalBestMs: number;
  isPersonalBest: boolean;
  /** Rank after this submit (based on personal best). */
  rank: number;
  /** Rank before this submit; null on first verified score. */
  previousRank: number | null;
  /** How many places the player climbed (0 if unchanged / first / worse). */
  ranksGained: number;
}

/** Standing used on profile badges and the /me endpoint. */
export interface MinesweeperStanding {
  personalBestMs: number | null;
  rank: number | null;
  moveCount?: number;
  verifiedAt?: string;
}

export interface LeaderboardEntry {
  /** The score row itself - what a global admin's "remove this score" names. */
  scoreId: string;
  rank: number;
  userId: string;
  displayName: string;
  durationMs: number;
  moveCount: number;
  verifiedAt: string;
}

/** A user banned from the ranked game, as a global admin sees them. */
export interface MinesweeperBan {
  userId: string;
  displayName: string;
  reason: string | null;
  bannedBy: string;
  bannedAt: string;
}

/**
 * The server refused a ranked challenge to a user a global admin banned (403). Typed here, at the
 * throw, so the modal can SAY so instead of dropping the player into a casual game without a word -
 * a distinction carried in an error message is one call site's guess.
 */
export class MinesweeperBannedError extends Error {
  constructor() {
    super('banned from the ranked minesweeper');
    this.name = 'MinesweeperBannedError';
  }
}

/** Base path for minesweeper API on social-service (same-origin via nginx when unset). */
function minesweeperBase(): string {
  const base = socialUrl();
  return base ? `${base}/api/minesweeper` : '/api/minesweeper';
}

/** Starts a ranked seeded challenge (server clock begins). */
export async function startMinesweeperChallenge(): Promise<MinesweeperChallengeResponse> {
  const res = await apiFetch(`${minesweeperBase()}/challenges`, { method: 'POST' });
  if (res.status === 403) throw new MinesweeperBannedError();
  if (!res.ok) {
    throw new Error(`Failed to start challenge (${res.status})`);
  }
  return res.json();
}

/** Submits a move log for server-side replay verification. */
export async function submitMinesweeperChallenge(
  challengeId: string,
  moves: MinesweeperMove[],
  claimedDurationMs: number,
  challengeRoundTripMs?: number
): Promise<MinesweeperSubmitResponse> {
  const res = await apiFetch(`${minesweeperBase()}/challenges/${challengeId}/submit`, {
    method: 'POST',
    body: JSON.stringify({
      moves,
      claimedDurationMs,
      ...(challengeRoundTripMs !== undefined ? { challengeRoundTripMs } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Submit failed (${res.status})`);
  }
  return res.json();
}

/** Fetches the verified leaderboard (best time per user). */
export async function fetchMinesweeperLeaderboard(limit = 25): Promise<LeaderboardEntry[]> {
  const res = await apiFetch(`${minesweeperBase()}/leaderboard?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`Failed to load leaderboard (${res.status})`);
  }
  const data = (await res.json()) as { entries: LeaderboardEntry[] };
  return data.entries ?? [];
}

/** Caller's personal best + rank (nulls when never scored). */
export async function fetchMinesweeperMe(): Promise<MinesweeperStanding> {
  const res = await apiFetch(`${minesweeperBase()}/me`);
  if (!res.ok) {
    throw new Error(`Failed to load minesweeper standing (${res.status})`);
  }
  return res.json();
}

/** Standing for any user — used on public/own profile badges. */
export async function fetchMinesweeperUserStanding(userId: string): Promise<MinesweeperStanding> {
  const res = await apiFetch(`${minesweeperBase()}/users/${encodeURIComponent(userId)}`);
  if (!res.ok) {
    throw new Error(`Failed to load minesweeper standing (${res.status})`);
  }
  return res.json();
}

// ---- Moderation: global admins only - the server refuses anyone else with a 403 ----

/** Removes one verified score; the player keeps their others. */
export async function removeMinesweeperScore(scoreId: string): Promise<void> {
  const res = await apiFetch(`${minesweeperBase()}/scores/${encodeURIComponent(scoreId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to remove the score (${res.status})`);
}

/** Bans a user from the ranked game. Their scores are hidden, not deleted. */
export async function banMinesweeperUser(userId: string, reason?: string): Promise<void> {
  const res = await apiFetch(`${minesweeperBase()}/bans`, {
    method: 'POST',
    body: JSON.stringify({ userId, ...(reason ? { reason } : {}) }),
  });
  if (!res.ok) throw new Error(`Failed to ban the user (${res.status})`);
}

/** Lifts a ban: the player's scores and rank come back as they were. */
export async function unbanMinesweeperUser(userId: string): Promise<void> {
  const res = await apiFetch(`${minesweeperBase()}/bans/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to lift the ban (${res.status})`);
}

/** Everyone currently banned from the ranked game. */
export async function fetchMinesweeperBans(): Promise<MinesweeperBan[]> {
  const res = await apiFetch(`${minesweeperBase()}/bans`);
  if (!res.ok) throw new Error(`Failed to load the bans (${res.status})`);
  const data = (await res.json()) as { bans: MinesweeperBan[] };
  return data.bans ?? [];
}

/** Formats a duration for the HUD / leaderboard. */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const frac = Math.floor((ms % 1000) / 10);
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}.${String(frac).padStart(2, '0')}`;
  return `${s}.${String(frac).padStart(2, '0')}s`;
}
