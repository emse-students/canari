import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { IStorage, StoredGraineSession } from '$lib/db/types';
import type { GraineHistoryVisibility } from '$lib/crypto/graineConstants';

/**
 * What the Graine layer needs from the session, injected once rather than imported.
 *
 * Sealing a channel message needs four things a `.ts` utility has no business reaching for: the
 * device key, the local store, the MLS client and who this device is. They are all decided at
 * login and all invalid after logout, so they are set there and cleared there - the same shape as
 * `setDistributionGroupInfoTransport`, and for the same reason: a module that imported the auth
 * store would make the crypto untestable and the import graph circular.
 *
 * Protocol: `docs/wiki/protocols/channel-encryption.md`.
 */

/** Thrown when something asks the Graine layer to work before a session has wired it. */
export class GraineNotReadyError extends Error {
  constructor(what: string) {
    super(`[GRAINE] ${what} - no session is wired`);
    this.name = 'GraineNotReadyError';
  }
}

export interface GraineRuntime {
  storage: IStorage;
  deviceKeyB64: string;
  /** This device's user id, lower-cased once here so no caller has to remember to. */
  userId: string;
  mlsService: IMlsService;
}

let runtime: GraineRuntime | null = null;

/** Which community each channel belongs to - the one fact the send path cannot derive locally. */
const workspaceByChannel = new Map<string, string>();

/**
 * Installs (or, with null, tears down) the session's Graine wiring.
 *
 * Clearing also empties the channel map: it names channels of communities this account was in, and
 * the next account's channels are not those. A map that survived a logout would answer a workspace
 * id for somebody else's channel, and every wrong answer here is a seed sealed for the wrong
 * community.
 */
export function setGraineRuntime(next: GraineRuntime | null): void {
  runtime = next ? { ...next, userId: next.userId.toLowerCase() } : null;
  if (!next) {
    workspaceByChannel.clear();
    historyVisibilityByWorkspace.clear();
    seedCache.clear();
    repairListener = null;
  }
}

/** What each loaded community lets a newcomer read - the rule its members enforce. */
const historyVisibilityByWorkspace = new Map<string, GraineHistoryVisibility>();

/**
 * Records a community's history rule, narrowing whatever the wire said.
 *
 * Narrowed HERE and nowhere else, so a value the server does not recognise cannot reach the
 * decision that hands seeds over. An unknown word is refused rather than coerced to the default:
 * coercion is how a community whose admin closed its past ends up handing it out.
 */
export function registerCommunityHistoryVisibility(
  workspaceId: string,
  visibility: string
): GraineHistoryVisibility {
  const narrowed = narrowHistoryVisibility(visibility);
  historyVisibilityByWorkspace.set(workspaceId, narrowed);
  return narrowed;
}

/**
 * Turns whatever the wire said into one of the two values, refusing the unknown.
 *
 * The ONE place the narrowing happens, so the sidebar and the seed layer cannot end up disagreeing
 * about a community - a modal reading "shared" while this device answers joiners with nothing is a
 * divergence no log would ever name.
 */
export function narrowHistoryVisibility(visibility: string): GraineHistoryVisibility {
  if (visibility === 'shared' || visibility === 'joined') return visibility;
  console.warn(
    `[GRAINE] historyVisibility='${visibility}' is not a value this client knows - treating it as 'joined'`
  );
  return 'joined';
}

/**
 * A community's history rule, or `joined` when this session never learned it.
 *
 * **Fail-closed, and loudly.** The unknown case is a device about to decide whether to hand a
 * newcomer the past; refusing costs a newcomer some history they were entitled to, guessing `shared`
 * costs a community the privacy it asked for. Those are not symmetrical, so the cheap mistake is the
 * one taken - and it is logged, because the other symptom is a joiner with a blank salon.
 */
export function historyVisibilityFor(workspaceId: string): GraineHistoryVisibility {
  const known = historyVisibilityByWorkspace.get(workspaceId);
  if (known) return known;
  console.warn(
    `[GRAINE] no history rule known for community ${workspaceId.slice(0, 8)} - refusing to hand the past over`
  );
  return 'joined';
}

/**
 * Told which channels just gained seeds, so their history can be re-read.
 *
 * A repair lands minutes after the rows it repairs were rendered as unreadable and dropped, and
 * nothing else would ever go back for them: the next reload is whenever the user happens to leave
 * and re-enter the salon. Registered by the layer that owns conversations, so this module still
 * knows nothing about them.
 */
let repairListener: ((channelIds: string[]) => void) | null = null;

export function setGraineRepairListener(listener: ((channelIds: string[]) => void) | null): void {
  repairListener = listener;
}

/** Announces repaired channels, if anyone is listening. */
export function announceGraineRepair(channelIds: string[]): void {
  if (channelIds.length === 0) return;
  if (!repairListener) {
    // Not silent: the seeds DID arrive, and the only remaining symptom would be a salon whose
    // history stays blank until the user leaves and comes back to it.
    console.warn(
      `[GRAINE] ${channelIds.length} channel(s) repaired with no listener wired - their history will not re-render until reopened`
    );
    return;
  }
  repairListener(channelIds);
}

/**
 * Seeds already read out of the store, so a page of history does not decrypt the same row fifty
 * times. **Only an ANSWER is ever cached**: a session that was not found is re-asked for every
 * time, because "missing" is a state a repair (WP-33) is expected to change under us.
 *
 * Cleared with the runtime, like the channel map and for the same reason - these are decrypted
 * seeds, and they belong to the account that was logged in.
 */
const seedCache = new Map<string, StoredGraineSession>();

/** Remembers a session that WAS found. */
export function cacheGraineSession(session: StoredGraineSession): void {
  seedCache.set(session.sessionId, session);
}

/** A session read earlier in this session, or null. */
export function cachedGraineSession(sessionId: string): StoredGraineSession | null {
  return seedCache.get(sessionId) ?? null;
}

/** The session's Graine wiring. @throws {GraineNotReadyError} when none is installed. */
export function requireGraineRuntime(what: string): GraineRuntime {
  if (!runtime) throw new GraineNotReadyError(what);
  return runtime;
}

/** True when a session is wired, for callers that must degrade rather than throw. */
export function isGraineReady(): boolean {
  return runtime !== null;
}

/**
 * Records that `channelId` belongs to `workspaceId`.
 *
 * Called wherever a community's channels are loaded. The membership is a fact of the data model
 * and not context the caller should re-derive: a channel id alone reaches every send site here,
 * and the alternative was threading a workspace id through every one of them.
 */
export function registerChannelWorkspace(channelId: string, workspaceId: string): void {
  workspaceByChannel.set(rawChannelId(channelId), workspaceId);
}

/** The community a channel belongs to, or null when this session has never loaded it. */
export function workspaceForChannel(channelId: string): string | null {
  return workspaceByChannel.get(rawChannelId(channelId)) ?? null;
}

/** Strip the `channel_` conversation prefix: the map is keyed by the raw uuid, everywhere. */
export function rawChannelId(channelId: string): string {
  return String(channelId).replace(/^channel_/, '');
}
