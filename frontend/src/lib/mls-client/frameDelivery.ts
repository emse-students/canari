/**
 * How a frame is treated once it leaves the device.
 *
 * These two properties were a single boolean, `silent`, until 2026-08-12. On the client `silent`
 * meant "raise no notification"; on the server the same flag was read as "do not append to the
 * group's shared log" (`messaging.service.ts`). Because every control frame is silent by
 * construction, that overload is the reason no reaction, edit, deletion or read receipt ever had a
 * shared copy - a device that missed one could only ever obtain it from a peer that still held it.
 *
 * Splitting them is the foundation of the reconciliation rework specified in
 * `docs/wiki/protocols/history-reconciliation.md`. Nothing infers one from the other any more: the
 * sender declares both, because the server sees only ciphertext and cannot classify a frame itself.
 */
export interface FrameDelivery {
  /** Raise no notification and render no message. A presentation property, nothing else. */
  silent: boolean;
  /**
   * Append to the group's shared log, so a device that was absent can still obtain this frame
   * without a peer being online. False only for frames that carry no conversation state.
   */
  durable: boolean;
  /**
   * `userId:deviceId` keys the frame is ADDRESSED to, when it is meant for them and nobody else in
   * the group. The server narrows the group's recipient set to these (never widens it) and keeps the
   * frame out of the shared log, which every member reads. Absent = the whole group. Built by
   * {@link addressedKeyMaterial} and nowhere else.
   */
  recipients?: readonly string[];
}

/**
 * The four kinds of frame this application sends. Every send site picks one of these rather than
 * spelling out two booleans, so the classification lives here and only here.
 */
export const DELIVERY = {
  /**
   * A user-authored message, or a group event the members are meant to see
   * (rename, member added or removed, group deleted).
   */
  visible: { silent: false, durable: true },
  /**
   * A mutation of existing history - reaction, edit, deletion, pin, read receipt. It must not
   * notify, and it must survive: a device that was offline when it was sent has no other way to
   * learn about it once the sender's queue entry has been acknowledged and deleted.
   */
  mutation: { silent: true, durable: true },
  /**
   * Point-to-point reconciliation traffic - state keys, digests, pulls, bundles. It carries no
   * conversation state of its own, only a restatement of state held elsewhere, so replaying it
   * from the shared log would be circular. Writing it there would also evict genuine messages: the
   * log is capped per group.
   */
  transport: { silent: true, durable: false },
  /**
   * A Graine seed, on a community's key-distribution group. Silent - it is not a message and there
   * is nothing to show - and durable, because a member who was offline when a seed went out has no
   * other way to obtain it than to ask a peer, and asking costs a round trip per absence.
   *
   * Shaped like {@link DELIVERY.mutation} and named apart from it on purpose: the eviction argument
   * differs. The log is capped per group, and a distribution group's log carries seeds and nothing
   * else, so the whole cap is spent on exactly the thing that needs it.
   */
  keyMaterial: { silent: true, durable: true },
} as const satisfies Record<string, FrameDelivery>;

/**
 * A Graine answer to ONE device's seed request: key material, delivered to that device and to
 * nobody else (channel-encryption section 23).
 *
 * Durable, for the reason {@link DELIVERY.keyMaterial} is - the requester may have no socket yet
 * (a cold start asks over HTTP before it has one, COMM-18), and an answer dropped then strands the
 * session. Addressed, because the answer used to be queued for EVERY seat of the key group: on
 * production 2026-10-12 a seed bundle cost ~42 rows per payload on a 112-seat community, and bundles
 * were 70 % of that group's queued bytes, for seeds nobody else had asked for.
 *
 * @param device The requesting device as `userId:deviceId`, the user id lower-cased.
 */
export function addressedKeyMaterial(device: string): FrameDelivery {
  return { ...DELIVERY.keyMaterial, recipients: [device] };
}

/**
 * A history answer on a conversation, to the ONE device that asked (step A,
 * docs/wiki/protocols/history-answer-addressing.md): transport, as every history frame, and
 * addressed - the server refuses an addressed conversation frame that is durable, and one to a device
 * that did not declare {@link ADDRESSED_HISTORY_CAPABILITY}.
 *
 * @param device The asking device as `userId:deviceId`, the user id lower-cased (`digestIdentity`).
 */
export function addressedHistoryAnswer(device: string): FrameDelivery {
  return { ...DELIVERY.transport, recipients: [device] };
}

/**
 * The capability this build declares on its socket (`caps=` on `/api/ws`): it refuses an addressed
 * conversation frame that is not a solicited, bounded history answer (`historyAddressing.ts`). The
 * gateway records each session's declaration in a store every gateway process shares, chat-delivery
 * addresses a conversation frame only to a device ALL of whose sessions declared it, and the gateway
 * drops an addressed frame on a session that did not. The same literal is in chat-delivery
 * (`ADDRESSED_HISTORY_CAPABILITY`) and the gateway (`addressing.rs`).
 */
export const ADDRESSED_HISTORY_CAPABILITY = 'addressed-history-1';

/**
 * The capability this build declares because it routes the invitation-link ask frames
 * (`group.join_ask`, `group.join_ask.settled`, `channelEventHandler.ts`). chat-delivery sends them
 * only to a device all of whose sessions declared it, and the gateway keeps them from a session that
 * did not - so a build older than these frames never meets one it would report as reaching no
 * handler. The same literal is in chat-delivery and the gateway (`JOIN_ASK_CAPABILITY`).
 */
export const JOIN_ASK_CAPABILITY = 'join-ask-1';

/** Every capability this build declares on its socket, comma-separated as `caps=` carries them. */
export const SOCKET_CAPABILITIES = [ADDRESSED_HISTORY_CAPABILITY, JOIN_ASK_CAPABILITY].join(',');

/**
 * The gateway socket URL, built in ONE place for both openers (web and Tauri) so the two cannot
 * declare different capabilities. Every session declares: a tab is a reader of every frame routed
 * to the device, so each one says what it applies. `redacted` is the same URL with the token masked,
 * the only form that may reach a log line.
 */
export function gatewaySocketUrl(
  wsBase: string,
  deviceId: string,
  token?: string
): { url: string; redacted: string } {
  const base = `${wsBase}/api/ws?device_id=${encodeURIComponent(deviceId)}&caps=${encodeURIComponent(SOCKET_CAPABILITIES)}`;
  return {
    url: token ? `${base}&token=${encodeURIComponent(token)}` : base,
    redacted: token ? `${base}&token=***` : `${base} (no token)`,
  };
}
