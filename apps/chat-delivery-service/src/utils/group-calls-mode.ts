import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Whether this estate lets a GROUP call start - the switch of WP-GC2 (2026-11-13).
 *
 * `platform_config.group_calls_mode` is owned by core-service (migration
 * `022_platform_config_group_calls_mode.sql`, edited at `/admin/platform`) and READ here, as
 * `readCallsMode` reads `calls_mode`: enforced where a call starts, never cached.
 *
 * - `off` (the default): `initiate` for a conversation of more than two members answers 403
 *   `GROUP_CALLS_DISABLED`. A 1:1 call is untouched.
 * - `mesh`: a group call goes peer to peer, every participant holding one connection per other one,
 *   up to {@link MESH_SEATS_AUDIO} participants in audio and {@link MESH_SEATS_VIDEO} in video (owner
 *   decision D-A, 2026-10-31). The cap is signed into the room token (`max_seats`) and call-service
 *   refuses the user past it.
 *
 * `calls_mode = off` still closes every call, group ones included: `assertCallsOpen` runs first.
 */
export type GroupCallsMode = 'off' | 'mesh';

/** The two values, the same list as the column's CHECK (asserted across every copy). */
export const GROUP_CALLS_MODES: readonly GroupCallsMode[] = ['off', 'mesh'];

/** The mesh cap of an AUDIO group call: the owner's D-A, where the uplink and ICE cost start to matter. */
export const MESH_SEATS_AUDIO = 4;

/** The mesh cap of a VIDEO group call: the Mi 9T already drops frames encoding for two receivers (Q3). */
export const MESH_SEATS_VIDEO = 3;

/**
 * The group-call version of a binary that speaks the MESH: one connection and one per-sender key
 * per other participant, signalling addressed by peer. A device declares what it speaks on every
 * push registration (`push_token."groupCallVersion"`, migration 050) and on every group call's
 * initiate and room-token request; 0 - an absent field - is a build that predates group calls.
 */
export const GROUP_CALL_MESH_VERSION = 1;

/**
 * The group-call version of a binary that ALSO speaks the SFU leg (`Join { mode: 'sfu' }`, one
 * connection to the relay, the sender read from each forwarded stream id). Cumulative: a build at
 * 2 speaks the mesh too. A group call goes through the relay only when its CALLER declared it, and
 * only builds that declared it are rung for, or given a token to, a relayed call - a mesh-only build
 * joins `p2p` and would be refused `mode-mismatch` (review of #3497).
 */
export const GROUP_CALL_SFU_VERSION = 2;

/**
 * The group-call version a request or a registration declared: a non-negative integer, capped at
 * the highest version this server knows; anything else is 0 and `malformed`, so the caller can
 * accuse it. Absent is 0 and NOT malformed - an old build saying nothing is the ordinary case.
 */
export function parseGroupCallVersion(declared: unknown): { version: number; malformed: boolean } {
  if (declared === undefined || declared === null) return { version: 0, malformed: false };
  if (typeof declared === 'number' && Number.isInteger(declared) && declared >= 0) {
    return { version: Math.min(declared, GROUP_CALL_SFU_VERSION), malformed: false };
  }
  if (typeof declared === 'string' && /^\d{1,3}$/.test(declared)) {
    return { version: Math.min(Number(declared), GROUP_CALL_SFU_VERSION), malformed: false };
  }
  return { version: 0, malformed: true };
}

/**
 * The mode as the database holds it RIGHT NOW. An absent row reads `off` and logs at ERROR (a
 * missing row is a defect, a closed switch a decision); an unknown value THROWS - a switch that
 * cannot be read is not read as open.
 */
export async function readGroupCallsMode(
  manager: EntityManager,
  logger: Logger
): Promise<GroupCallsMode> {
  const rows: { group_calls_mode?: unknown }[] = await manager.query(
    `SELECT group_calls_mode FROM platform_config WHERE id = 1 LIMIT 1`
  );
  if (rows.length === 0) {
    logger.error(
      '[call] platform_config row 1 is MISSING - group calls read as off (has core-service booted against this database?)'
    );
    return 'off';
  }
  const value = rows[0]?.group_calls_mode;
  if (typeof value === 'string' && (GROUP_CALLS_MODES as readonly string[]).includes(value)) {
    return value as GroupCallsMode;
  }
  throw new Error(`platform_config.group_calls_mode holds an unknown value: ${String(value)}`);
}
