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
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  durationMs: number;
  moveCount: number;
  verifiedAt: string;
}

/** Base path for minesweeper API on social-service (same-origin via nginx when unset). */
function minesweeperBase(): string {
  const base = socialUrl();
  return base ? `${base}/api/minesweeper` : '/api/minesweeper';
}

/** Starts a ranked seeded challenge (server clock begins). */
export async function startMinesweeperChallenge(): Promise<MinesweeperChallengeResponse> {
  const res = await apiFetch(`${minesweeperBase()}/challenges`, { method: 'POST' });
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

/** Formats a duration for the HUD / leaderboard. */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const frac = Math.floor((ms % 1000) / 10);
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}.${String(frac).padStart(2, '0')}`;
  return `${s}.${String(frac).padStart(2, '0')}s`;
}
