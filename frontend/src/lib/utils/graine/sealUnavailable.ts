/**
 * Why this device cannot seal for a scope right now - one value per fact that can be missing, so
 * the toast, the log and a test all read the same discriminator instead of a sentence.
 *
 * - `no-session`: no Graine runtime is wired (before login settles, after logout).
 * - `unknown-channel`: the salon belongs to no community this session has loaded.
 * - `key-group-unregistered`: no key group is registered for the salon's scope - the join never ran
 *   or never reached the server.
 * - `key-group-not-held`: a key group is registered but this device holds no tree for it.
 * - `key-group-unsettled`: this device created the key group and the server has not yet said
 *   whether its base won the first publish.
 * - `key-group-catching-up`: the key group is behind the server and a catch-up is in progress, so
 *   anything sealed now would be sealed at an epoch the other members have left.
 */
export type GraineSealUnavailableReason =
  | 'no-session'
  | 'unknown-channel'
  | 'key-group-unregistered'
  | 'key-group-not-held'
  | 'key-group-unsettled'
  | 'key-group-catching-up';

/**
 * Base of every error meaning "this device cannot seal for this scope RIGHT NOW, and nothing was
 * sent". It is classified at the throw so a caller reads `instanceof` and {@link reason}, never the
 * sentence.
 *
 * Kept import-free on purpose: `runtime`, `channelSeal` and `seedDistribution` each throw a
 * subclass, and a shared base that imported any of them would be a cycle.
 */
export class GraineSealUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: GraineSealUnavailableReason
  ) {
    super(message);
    this.name = 'GraineSealUnavailableError';
  }
}
