/**
 * WHO MAY RECEIVE AN ADDRESSED CONVERSATION FRAME - rule 6 of
 * docs/wiki/protocols/history-answer-addressing.md, as chat-delivery reads it.
 *
 * MLS encrypts a history answer for the whole group, so addressing it to one device is a routing
 * control only, and a session whose code predates rule 5 would apply such a frame as an ordinary
 * one. The gateway records what every session of a device declared, across every gateway process
 * (`apps/chat-gateway/src/addressing.rs`); this module reads it in ONE place, used by the check
 * before a send, by the publish itself, and by the pull.
 */

/**
 * The capability a session declares (`caps=` on `/api/ws` and on the pending fetch) when its code
 * refuses an addressed conversation frame that is not a solicited history answer. The same literal
 * is in `apps/chat-gateway/src/addressing.rs` and the client's `frameDelivery.ts`; a new rule 5
 * would be a new capability, never a reinterpretation of this one.
 */
export const ADDRESSED_HISTORY_CAPABILITY = 'addressed-history-1';

/**
 * The capability a session declares when its code routes the invitation-link ask frames
 * (`group.join_ask`, `group.join_ask.settled`). Those are published only to a device ALL of whose
 * sessions declared it ({@link publishIfAddressable}), and carry it as `requiresCapability` so the
 * gateway keeps them from a session that connected since without it - a client that predates them
 * would meet a frame it routes nowhere. The same literal is in the gateway and the client.
 */
export const JOIN_ASK_CAPABILITY = 'join-ask-1';

/** A capability the gateway records per session and chat-delivery may require of a device. */
export type SessionCapability = typeof ADDRESSED_HISTORY_CAPABILITY | typeof JOIN_ASK_CAPABILITY;

/**
 * The presence key of ONE device - THE one spelling, read by every check of whether a device is
 * online. The gateway writes it on connect (`apps/chat-gateway/src/addressing.rs`) and lets it expire.
 */
export function devicePresenceKey(userId: string, deviceId: string): string {
  return `user:online:${userId}:${deviceId}`;
}

/**
 * The presence value written by a gateway that records every session in
 * {@link addressingSessionsKey}. An older gateway writes `true` and records nothing, and a current
 * one never overwrites that `true` - so any other value means a session whose declaration nobody
 * can read may be live.
 */
export const PRESENCE_SESSIONS = 'sessions-1';

/**
 * The hash holding one field per live session of a device, on every gateway process, valued with
 * what that session declared. Deliberately outside `user:*`, which the presence scans match.
 */
export function addressingSessionsKey(userId: string, deviceId: string): string {
  return `addressing:sessions:${userId}:${deviceId}`;
}

/** Whether a `caps=` value (comma-separated) declares {@link ADDRESSED_HISTORY_CAPABILITY}. */
export function declaresAddressedHistory(caps: string | undefined | null): boolean {
  return (
    typeof caps === 'string' &&
    caps.split(',').some((cap) => cap.trim() === ADDRESSED_HISTORY_CAPABILITY)
  );
}

/**
 * THE CHECK AND THE PUBLISH IN ONE SCRIPT, so no session can register between them.
 *
 * KEYS: the presence key, the sessions hash. ARGV: channel (empty = check only), payload,
 * capability, sessions marker. Returns 1 when every session of the device declared the capability
 * (and the frame was published, when a channel was given), 0 otherwise. Redis runs a script alone,
 * so a session the gateway records after this ran is one the frame was already published before -
 * and the gateway's edge filter keeps it from that session anyway.
 *
 * A session's value is a comma-separated LIST of what it declared (or `-`), so the capability is
 * looked for among its items, never compared with the whole value.
 */
export const ADDRESSABLE_PUBLISH_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[4] then return 0 end
local declared = redis.call('HVALS', KEYS[2])
if #declared == 0 then return 0 end
for _, value in ipairs(declared) do
  local holds = false
  for cap in string.gmatch(value, '[^,]+') do
    if cap == ARGV[3] then holds = true end
  end
  if not holds then return 0 end
end
if ARGV[1] ~= '' then redis.call('PUBLISH', ARGV[1], ARGV[2]) end
return 1
`;

/** The `EVAL` call {@link ADDRESSABLE_PUBLISH_LUA} takes, typed for the one client this service uses. */
export interface EvalCapable {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Whether every session of the device declared `capability` now and, when `publish` is given, the
 * frame published in the same atomic step. True only when the script answered 1.
 */
export async function publishIfAddressable(
  redis: EvalCapable,
  userId: string,
  deviceId: string,
  publish?: { channel: string; payload: string },
  capability: SessionCapability = ADDRESSED_HISTORY_CAPABILITY
): Promise<boolean> {
  const answer = await redis.eval(
    ADDRESSABLE_PUBLISH_LUA,
    2,
    devicePresenceKey(userId, deviceId),
    addressingSessionsKey(userId, deviceId),
    publish?.channel ?? '',
    publish?.payload ?? '',
    capability,
    PRESENCE_SESSIONS
  );
  return Number(answer) === 1;
}
