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
}

/**
 * The three kinds of frame this application sends. Every send site picks one of these rather than
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
} as const satisfies Record<string, FrameDelivery>;
