import { GraineSealUnavailableError } from './sealUnavailable';
import type { BulkIngestObserver, IMlsService } from '$lib/mls-client/IMlsService';
import type { IStorage, StoredGraineSession } from '$lib/db/types';
import type { GraineHistoryVisibility } from '$lib/crypto/graineConstants';
import { resetChannelReadSignals } from '$lib/utils/chat/channelReadSignal';
import { forgetSalonSendGates, resetSalonSendGate } from './salonSendGate';
import {
  channelScope,
  workspaceScope,
  type DistributionScope,
} from '$lib/mls-client/distributionScope';

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
export class GraineNotReadyError extends GraineSealUnavailableError {
  constructor(what: string) {
    super(`[GRAINE] ${what} - no session is wired`, 'no-session');
    this.name = 'GraineNotReadyError';
  }
}

export interface GraineRuntime {
  storage: IStorage;
  /**
   * The key the store is sealed with NOW. A function, because this wiring outlives the key: an
   * in-session PIN change re-seals every seed (`resealDeviceKeyStores`) and moves the session's
   * key, and a value captured at login kept sealing every later seed under the abandoned one -
   * unreadable at the next launch, and a seed cannot be re-fetched. Read it at each store access.
   */
  deviceKey: () => string;
  /** This device's user id, lower-cased once here so no caller has to remember to. */
  userId: string;
  mlsService: IMlsService;
}

let runtime: GraineRuntime | null = null;

/**
 * Which distribution group each channel's seeds travel on - the one fact the send path cannot
 * derive locally.
 *
 * The value is a SCOPE and not a community id, because since 2026-08-19 the answer differs per
 * salon: a public one rides the community's group, a private one has its own. Both facts are
 * learned at the same moment, from the same DTO, so storing one and re-deriving the other at the
 * send site would mean the send site asking a question the loader had already answered.
 */
const scopeByChannel = new Map<string, DistributionScope>();

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
    scopeByChannel.clear();
    listedCommunities.clear();
    seedsAwaitingListing.clear();
    historyVisibilityByWorkspace.clear();
    dropHistoryRuleWaiters(null, 'the session ended');
    seedCache.clear();
    openedKeys.clear();
    repairListener = null;
    // Salons of the account that is leaving. The DEPTH is kept: it counts windows the MLS service
    // opened and will close, and zeroing it here would turn their closes into unmatched releases.
    heldRepairs.clear();
    // Same reason: the markers name salons of this account, and "already told my other devices" is
    // a claim about THIS account's devices. The next one inherits none of it.
    resetChannelReadSignals();
    // The sends still waiting for a salon of the account that is leaving are refused, out loud,
    // and the gate waits for the next account's own first listing.
    resetSalonSendGate();
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
  const waiting = historyRuleWaiters.get(workspaceId);
  if (waiting) {
    historyRuleWaiters.delete(workspaceId);
    console.info(
      `[GRAINE] community ${workspaceId.slice(0, 8)}'s history rule is known ('${narrowed}') - ` +
        `resuming ${waiting.length} step(s) that waited for it`
    );
    for (const resume of waiting) resume();
  }
  return narrowed;
}

/** Steps deferred until a community's history rule is known - see {@link whenHistoryRuleKnown}. */
const historyRuleWaiters = new Map<string, (() => void)[]>();

/** How many steps may wait for a history rule at once, across communities. */
export const MAX_HISTORY_RULE_WAITERS = 256;

/**
 * Runs `resume` once the server has stated `workspaceId`'s history rule
 * ({@link registerCommunityHistoryVisibility}) - for a step that may neither guess the rule nor
 * read the fail-closed default as a floor: a seed bundle that arrived before the community listing,
 * or a seed ask this device cannot answer yet (`parkedAsks.ts`).
 *
 * Event-driven, never a clock. Dropped with the session, or with the community leaving this device,
 * said out loud: what waited is then asked for again by the next start's history ask. Bounded by
 * {@link MAX_HISTORY_RULE_WAITERS}, since nothing but the rule drains it.
 *
 * @returns false when the bound is reached: `resume` will never run, and the caller says so.
 */
export function whenHistoryRuleKnown(workspaceId: string, resume: () => void): boolean {
  let waitingNow = 0;
  for (const steps of historyRuleWaiters.values()) waitingNow += steps.length;
  if (waitingNow >= MAX_HISTORY_RULE_WAITERS) return false;
  const waiting = historyRuleWaiters.get(workspaceId) ?? [];
  waiting.push(resume);
  historyRuleWaiters.set(workspaceId, waiting);
  return true;
}

/** Drops the deferred steps of `workspaceId` (all communities with `null`), saying how many. */
function dropHistoryRuleWaiters(workspaceId: string | null, why: string): void {
  const dropped =
    workspaceId === null
      ? [...historyRuleWaiters.values()].reduce((n, w) => n + w.length, 0)
      : (historyRuleWaiters.get(workspaceId)?.length ?? 0);
  if (workspaceId === null) historyRuleWaiters.clear();
  else historyRuleWaiters.delete(workspaceId);
  if (dropped > 0) {
    console.info(
      `[GRAINE] dropping ${dropped} step(s) that waited for a history rule: ${why} - the next start asks again`
    );
  }
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
 * A community's history rule as the server last said it in this session, or `null` when it never
 * did - WITHOUT the fail-closed reading of {@link historyVisibilityFor}.
 *
 * For the questions where `joined` by default would be a lie rather than a precaution:
 *
 * - whether the community's past was CLOSED to this member, which is what makes a later `shared` a
 *   widening owed a history ask (`requestCommunityHistory`). Recording a closed past from a rule
 *   nobody stated would ask the whole past again the first time the real `shared` arrived;
 * - whether a seed may be handed over or kept FLOORED (`frameHandler`). A floor drawn under a rule
 *   nobody stated is not a precaution but a loss: a `shared` community's newcomer answered with
 *   the floored past records it as answered and never asks again. So an unknown rule answers with
 *   silence and defers a bundle, and never floors.
 */
export function knownHistoryVisibility(workspaceId: string): GraineHistoryVisibility | null {
  return historyVisibilityByWorkspace.get(workspaceId) ?? null;
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

/**
 * How many bulk-ingest windows are open, and the salons repaired inside them.
 *
 * ONE RE-READ PER SALON PER DRAIN, NOT ONE PER SEED. A device coming back reads its queued frames in
 * one drain, and every member who started a session while it was away put a seed in that queue. Each
 * seed announced its salon on arrival, and each announcement re-read the salon's whole page
 * (`messages?limit=200` + `read-marks`) and re-decrypted it: measured on a production web console
 * 2026-10-12 (`v1.2.5`), 26 seeds for 3 salons in 1.8 s became 26 history reloads - 52 requests, 14
 * of them for one salon - where 3 would have drawn the same rows.
 *
 * HELD BY THE DRAIN'S OWN WINDOW, NOT BY A TIMER. `beginBulkIngest`/`endBulkIngest` pair exactly
 * (`IMlsService.BulkIngestObserver`), so the release is the moment the last queued frame has been
 * read - the one moment after which a re-read sees every seed the drain brought. A debounce would be
 * a guess at that moment; the window IS it. Nested windows release at the outermost close.
 */
let repairHoldDepth = 0;
const heldRepairs = new Set<string>();

/** Opens a hold: repairs announced until the matching {@link releaseGraineRepairs} are deferred. */
export function holdGraineRepairs(): void {
  repairHoldDepth += 1;
}

/**
 * Closes a hold; at the outermost close, announces every salon repaired inside it, once each.
 *
 * An unmatched release is said and ignored rather than driving the depth negative, which would
 * defer every later repair for the rest of the session.
 */
export function releaseGraineRepairs(): void {
  if (repairHoldDepth === 0) {
    console.warn('[GRAINE] repair hold released without a matching hold - ignored');
    return;
  }
  repairHoldDepth -= 1;
  if (repairHoldDepth > 0 || heldRepairs.size === 0) return;
  const channelIds = [...heldRepairs];
  heldRepairs.clear();
  console.debug(
    `[GRAINE] drain over - re-reading ${channelIds.length} salon(s) once for the seeds it brought`
  );
  deliverRepair(channelIds);
}

/**
 * The hold, wired to the MLS service's bulk-ingest windows - but ONLY to the queue drain's.
 *
 * A bulk-ingest window is not always a drain. A history restore opens one too
 * (`withMlsBulkIngest`, `bufferUi: false`), and the startup restore wraps every conversation's
 * replay in ONE window that lasts as long as all of them - minutes on an account rejoining many
 * conversations. Holding on that window kept a salon's repair from a live seed until every
 * conversation had been replayed, so a salon opened at startup stayed blank for all that time
 * although its seed had arrived. The drain is the window that carries the seeds, and it is the one
 * that buffers the UI (`bufferUi: true`), so that flag - on BOTH sides, since a close replays the
 * exact phase its open used - is what names it.
 */
export const graineRepairHoldObserver: BulkIngestObserver = {
  onBulkIngestStart(phase) {
    if (phase.bufferUi) holdGraineRepairs();
  },
  onBulkIngestEnd(phase) {
    if (phase.bufferUi) releaseGraineRepairs();
  },
};

/**
 * Announces repaired channels, if anyone is listening - or, inside a drain, notes them for its end.
 *
 * @see holdGraineRepairs
 */
export function announceGraineRepair(channelIds: string[]): void {
  if (channelIds.length === 0) return;
  if (repairHoldDepth > 0) {
    for (const id of channelIds) heldRepairs.add(id);
    return;
  }
  deliverRepair(channelIds);
}

/** Hands repaired channels to the listener, or says that nobody will re-read them. */
function deliverRepair(channelIds: string[]): void {
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

/**
 * Which row first opened each message key, `sessionId#index` -> row id.
 *
 * A key is HKDF(seed, session, index), so two rows naming one key are one message shown twice - a
 * replayed ciphertext - whatever the server says their ids are. Migration 065 refuses the second
 * row at the door; this is what makes that true against a server that serves one anyway. Written
 * only AFTER a row authenticated, so a forged row cannot claim the slot first and hide the real one.
 * Cleared with the runtime, like the seeds it is keyed on.
 */
const openedKeys = new Map<string, string>();

/**
 * Records that `rowId` opened message `index` of `sessionId`, and answers the OTHER row that
 * already did, or null. The same row opened twice (history, then the live event) is not a replay.
 */
export function claimOpenedKey(sessionId: string, index: number, rowId: string): string | null {
  const key = `${sessionId}#${index}`;
  const first = openedKeys.get(key);
  if (first === undefined) {
    openedKeys.set(key, rowId);
    return null;
  }
  return first === rowId ? null : first;
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
 * Records that `channelId` belongs to `workspaceId`, and which group its seeds travel on.
 *
 * Called wherever a community's channels are loaded. The membership is a fact of the data model
 * and not context the caller should re-derive: a channel id alone reaches every send site here,
 * and the alternative was threading a workspace id through every one of them.
 *
 * `isPrivate` comes from the same DTO and decides the scope. It is REQUIRED rather than defaulted,
 * deliberately: a default would be a guess about which roster a seed is sealed to, and the wrong
 * guess in the safe-looking direction (public) is the one that hands a private salon's seed to the
 * whole community.
 */
export function registerChannelWorkspace(
  channelId: string,
  workspaceId: string,
  isPrivate: boolean
): void {
  const channel = rawChannelId(channelId);
  scopeByChannel.set(
    channel,
    isPrivate ? channelScope(workspaceId, channel) : workspaceScope(workspaceId)
  );
  releaseSeedsAwaitingListing(channel, isPrivate);
}

/**
 * Communities whose salon listing has ANSWERED in this session - the fact that turns "a salon this
 * device does not know" from "not listed YET" into "not a salon this viewer may read".
 *
 * The listing names every PUBLIC salon of the community to every member; a PRIVATE salon only to
 * its members and to the community's administrators. So once it has answered, a salon it did not
 * name is either private and closed to this viewer, or created since - and a salon created since
 * reaches this device through `registerChannelWorkspace` (the channel-created event, or the next
 * listing), which is what releases its waiting seeds.
 */
const listedCommunities = new Set<string>();

/**
 * Records that `workspaceId`'s salon listing answered and every salon it named is registered.
 *
 * Called after the registration loop, never before it: a mark set first would class the salons
 * still being registered as unlisted.
 */
export function markCommunityListed(workspaceId: string): void {
  listedCommunities.add(workspaceId);
}

/** Whether `workspaceId`'s salon listing has answered in this session. */
export function isCommunityListed(workspaceId: string): boolean {
  return listedCommunities.has(workspaceId);
}

/**
 * Seeds that arrived on a community's key group for a salon its answered listing did not name,
 * raw channel id -> the admissions to run if that salon turns out public.
 *
 * NOT STORED, AND NOT LOST. Such a seed is either a private salon's this viewer may not read - it
 * must never be stored - or a public salon's created after the listing, whose seed beat the
 * channel-created event. Only the registration tells the two apart, so the seed waits for it in
 * memory: registered public, it is admitted; registered private, or the session ends, it is
 * dropped. Bounded by {@link MAX_SEEDS_AWAITING_LISTING}, since nothing but a registration drains it.
 */
const seedsAwaitingListing = new Map<
  string,
  { workspaceId: string; admits: (() => Promise<void>)[] }
>();

/** How many seeds may wait for a listing at once; past it a new one is dropped, out loud. */
const MAX_SEEDS_AWAITING_LISTING = 256;

/**
 * Holds `admit` until `channelId` is registered (see {@link seedsAwaitingListing}).
 *
 * @returns false when the bound is reached and the seed was dropped.
 */
export function awaitSalonListing(
  workspaceId: string,
  channelId: string,
  admit: () => Promise<void>
): boolean {
  const channel = rawChannelId(channelId);
  let waiting = 0;
  for (const entry of seedsAwaitingListing.values()) waiting += entry.admits.length;
  if (waiting >= MAX_SEEDS_AWAITING_LISTING) {
    console.warn(
      `[GRAINE] ${waiting} seed(s) already wait for a salon listing - dropping one more for salon ${channel.slice(0, 8)}; a repair asks for it once its salon is listed`
    );
    return false;
  }
  const entry = seedsAwaitingListing.get(channel) ?? { workspaceId, admits: [] };
  entry.admits.push(admit);
  seedsAwaitingListing.set(channel, entry);
  return true;
}

/** Runs, or drops, the seeds that waited for `channel`'s registration. */
function releaseSeedsAwaitingListing(channel: string, isPrivate: boolean): void {
  const waiting = seedsAwaitingListing.get(channel)?.admits;
  if (!waiting) return;
  seedsAwaitingListing.delete(channel);
  if (isPrivate) {
    // Registered as a private salon: its seeds ride its own key group, never the community's.
    console.info(
      `[GRAINE] dropping ${waiting.length} seed(s) that arrived on the community's key group for salon ${channel.slice(0, 8)}: it is a private salon`
    );
    return;
  }
  console.debug(
    `[GRAINE] salon ${channel.slice(0, 8)} is listed as public - admitting the ${waiting.length} seed(s) that waited for it`
  );
  for (const admit of waiting) {
    admit().catch((e: unknown) =>
      console.error(
        `[GRAINE] a seed that waited for salon ${channel.slice(0, 8)} could not be admitted: ${String(e)}`
      )
    );
  }
}

/** The community a channel belongs to, or null when this session has never loaded it. */
export function workspaceForChannel(channelId: string): string | null {
  return scopeByChannel.get(rawChannelId(channelId))?.workspaceId ?? null;
}

/**
 * The distribution group a channel's seeds travel on, or null when this session has never loaded
 * it.
 *
 * The whole reason a private salon's guarantee is cryptographic: the seed goes out on a group whose
 * roster is the salon's, so nobody outside it is even sent the material, rather than being sent it
 * and refused the ciphertext.
 */
export function scopeForChannel(channelId: string): DistributionScope | null {
  return scopeByChannel.get(rawChannelId(channelId)) ?? null;
}

/**
 * Forgets, in memory, everything this session knew about one community.
 *
 * The three maps here are keyed differently - by session, by channel, by workspace - so the caller
 * has to hand over the sessions and channels it just purged; deriving them here would mean reading
 * a store the purge has already emptied.
 *
 * @param workspaceId Community leaving this device.
 * @param sessionIds Sessions whose decrypted seeds must leave the cache.
 * @param channelIds Channels of that community, raw uuid or `channel_`-prefixed.
 */
export function forgetWorkspaceGraineState(
  workspaceId: string,
  sessionIds: readonly string[],
  channelIds: readonly string[]
): void {
  for (const sessionId of sessionIds) seedCache.delete(sessionId);
  for (const channelId of channelIds) scopeByChannel.delete(rawChannelId(channelId));
  // By community, not by the channels handed over: a seed waits precisely for a salon no listing
  // named, so it is in none of them.
  for (const [channel, entry] of seedsAwaitingListing) {
    if (entry.workspaceId === workspaceId) seedsAwaitingListing.delete(channel);
  }
  listedCommunities.delete(workspaceId);
  // A send still waiting for one of these salons can never be sealed now: refused as `left`.
  forgetSalonSendGates(channelIds);
  historyVisibilityByWorkspace.delete(workspaceId);
  dropHistoryRuleWaiters(workspaceId, 'the community left this device');
}

/**
 * Evicts decrypted seeds from the in-process cache, keeping every other map intact.
 *
 * The counterpart of {@link forgetWorkspaceGraineState} at the scope the retention sweep works at:
 * individual sessions, in communities this device is still a member of. Nothing else may be
 * touched - the channel is still there, the community is still there, and dropping their entries
 * would cost this tab the workspace of a channel it is about to seal a message for.
 *
 * @param sessionIds Sessions whose decrypted seeds must leave the cache.
 */
export function forgetGraineSeedCache(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) seedCache.delete(sessionId);
}

/** Strip the `channel_` conversation prefix: the map is keyed by the raw uuid, everywhere. */
export function rawChannelId(channelId: string): string {
  return String(channelId).replace(/^channel_/, '');
}
