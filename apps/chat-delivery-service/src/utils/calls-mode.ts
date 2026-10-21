import type { EntityManager } from 'typeorm';

/**
 * Which calls an estate lets start - the server's kill switch (B12, owner 2026-10-21).
 *
 * `platform_config.calls_mode` is owned by core-service (migration `014_platform_config_calls_mode.sql`,
 * edited at `/admin/platform` by a global admin) and READ here, straight out of `auth_db`, as
 * `user-blocks.ts` reads `user_blocks`: the switch has to be enforced where a call is set up, and an
 * internal HTTP hop would cost a round trip on every call request. The three values are held
 * together by the column's CHECK constraint; core's `CallsMode` type is the same list.
 *
 * - `off`: no call may start - `initiate`, `ring`, `room-token` and `ice-servers` refuse.
 * - `audio`: a ring that asks for video is refused; everything else is allowed.
 * - `audio_video`: everything is allowed.
 */
export type CallsMode = 'off' | 'audio' | 'audio_video';

const CALLS_MODES: readonly string[] = ['off', 'audio', 'audio_video'];

/**
 * The mode as the database holds it RIGHT NOW. Read on every call request, never cached: a kill
 * must hold from the next request, not from the next cache expiry.
 *
 * Absent row: `off`, which is the column's default - core creates the row at boot, so an absent row
 * is a database core-service has not started against yet, and nothing may call on it. A value
 * outside the three is a defect (the CHECK constraint forbids it) and THROWS: a switch that cannot
 * be read is not read as open. A failed query throws too, and the request answers 500 - the call
 * does not start, which is the safe direction for a kill switch.
 */
export async function readCallsMode(manager: EntityManager): Promise<CallsMode> {
  const rows: { calls_mode?: unknown }[] = await manager.query(
    `SELECT calls_mode FROM platform_config WHERE id = 1 LIMIT 1`
  );
  if (rows.length === 0) return 'off';
  const value = rows[0]?.calls_mode;
  if (typeof value === 'string' && CALLS_MODES.includes(value)) return value as CallsMode;
  throw new Error(`platform_config.calls_mode holds an unknown value: ${String(value)}`);
}
