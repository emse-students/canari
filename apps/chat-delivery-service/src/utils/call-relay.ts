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
 * - `cloudflare` (WP-GC3): Cloudflare Realtime's SFU carries the group call, under the same interim
 *   rule - from the start, `mode: cloudflare` and {@link RELAY_SEATS} signed into the binding and
 *   every token. The client never meets Cloudflare's API directly: chat-delivery proxies it
 *   (`services/cloudflare-sfu.service.ts`), holding the app secret. A relay set to `cloudflare` on a
 *   server without the app's pair is REFUSED at `initiate` (`GROUP_CALL_RELAY_UNAVAILABLE`), never
 *   carried on the mesh in silence.
 */
export type CallRelay = 'none' | 'call-service' | 'cloudflare';

/** The three values, the same list as the column's CHECK (asserted across every copy). */
export const CALL_RELAYS: readonly CallRelay[] = ['none', 'call-service', 'cloudflare'];

/**
 * The `mode` a relayed group call's binding, room tokens and `initiate`/`room-token` answers carry:
 * `sfu` for call-service's SFU (the value call-service's `Join` already names), `cloudflare` for
 * Cloudflare Realtime. The client reads it from there, never from the setting.
 */
export type RelayMode = 'sfu' | 'cloudflare';

/** The mode a relay signs into its rooms; `null` for `none` (the mesh carries no mode). */
export function relayModeOf(relay: CallRelay): RelayMode | null {
  if (relay === 'call-service') return 'sfu';
  if (relay === 'cloudflare') return 'cloudflare';
  return null;
}

/**
 * The seat cap of a group call through a relay: call-service's own bound (`MAX_SFU_SEATS`,
 * `apps/call-service/src/sfu_seats.rs`), the same for audio and video - past the mesh cap is the
 * point of the relay. Cloudflare has no bound of ours to meet, and takes the same cap (decided
 * 2026-11-16, reversible) so the product rule is one number whichever relay is set; the proxy
 * enforces it atomically when a session claims a seat.
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
