import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Which relay carries a GROUP call - the setting of WP-GC4 (owner decision D2, 2026-11-01).
 *
 * `platform_config.call_relay` is owned by core-service (migration `023_platform_config_call_relay.sql`,
 * edited at `/admin/platform`) and READ here, as `readGroupCallsMode` reads `group_calls_mode`: at a
 * group call's `initiate`, never cached.
 *
 * - `none` (the default, production's value): a group call is the peer-to-peer mesh, and the
 *   participant past its cap is refused (`room-full`).
 * - `call-service`: our Rust SFU carries the group call, E2E transforms in the path throughout.
 *   INTERIM RULE (2026-11-13, reversible): the call goes through the relay FROM THE START - its
 *   binding and every room token say `mode: sfu` and carry {@link RELAY_SEATS} - until WP-GC5's
 *   mid-call switch from the mesh to the relay exists.
 *
 * `cloudflare` joins the list in the pull request that builds that leg.
 */
export type CallRelay = 'none' | 'call-service';

/** The two values, the same list as the column's CHECK (asserted across every copy). */
export const CALL_RELAYS: readonly CallRelay[] = ['none', 'call-service'];

/**
 * The seat cap of a group call through call-service's SFU: its own bound (`MAX_SFU_SEATS`,
 * `apps/call-service/src/sfu_seats.rs`), the same for audio and video - past the mesh cap is the
 * point of the relay.
 */
export const RELAY_SEATS = 8;

/**
 * The relay as the database holds it RIGHT NOW. An absent row reads `none` and logs at ERROR (a
 * missing row is a defect); an unknown value THROWS - a setting that cannot be read is not guessed.
 */
export async function readCallRelay(manager: EntityManager, logger: Logger): Promise<CallRelay> {
  const rows: { call_relay?: unknown }[] = await manager.query(
    `SELECT call_relay FROM platform_config WHERE id = 1 LIMIT 1`
  );
  if (rows.length === 0) {
    logger.error(
      '[call] platform_config row 1 is MISSING - the call relay reads as none (has core-service booted against this database?)'
    );
    return 'none';
  }
  const value = rows[0]?.call_relay;
  if (typeof value === 'string' && (CALL_RELAYS as readonly string[]).includes(value)) {
    return value as CallRelay;
  }
  throw new Error(`platform_config.call_relay holds an unknown value: ${String(value)}`);
}
