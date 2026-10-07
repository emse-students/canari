/**
 * Base of every error meaning "this device cannot seal for this scope RIGHT NOW, and nothing was
 * sent". It is classified at the throw so a caller reads `instanceof`, never the sentence.
 *
 * Kept import-free on purpose: `runtime`, `channelSeal` and `seedDistribution` each throw a
 * subclass, and a shared base that imported any of them would be a cycle.
 */
export class GraineSealUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraineSealUnavailableError';
  }
}
