import {
  buildAppVersionCheckResult,
  fetchServerAppVersionReliable,
  isMaintenanceBlockingUser,
  parseServerVersionInfo,
  serverVersionInfoToWire,
  type AppVersionCheckResult,
  type CallsMode,
  type CheckpointSkipMode,
  type GroupCallsMode,
  type LivesMode,
  type LiveReplaysMode,
} from '$lib/utils/appVersion';
import { connectivity } from '$lib/stores/connectivity.svelte';
import type { RetentionDays } from '$lib/legal/retention';

const CACHED_SERVER_VERSION_KEY = 'canari:last_server_version_info';

let lastCheck = $state<AppVersionCheckResult | null>(null);
let inflight: Promise<AppVersionCheckResult> | null = null;
/** The checkpoint-skip mode of the last LIVE answer this process obtained; see {@link serverCheckpointSkipMode}. */
let liveCheckpointSkipMode: CheckpointSkipMode = 'off';

function loadCachedServerInfo(): ReturnType<typeof parseServerVersionInfo> {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CACHED_SERVER_VERSION_KEY)?.trim();
    if (!raw) return null;
    return parseServerVersionInfo(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveCachedServerInfo(info: NonNullable<ReturnType<typeof parseServerVersionInfo>>): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    // The WIRE shape, the one `loadCachedServerInfo` parses: see `serverVersionInfoToWire`.
    sessionStorage.setItem(
      CACHED_SERVER_VERSION_KEY,
      JSON.stringify(serverVersionInfoToWire(info))
    );
  } catch {
    /* quota / private mode */
  }
}

/** Applies cached server metadata so gates can show before the network round-trip. */
function hydrateFromCachedServerInfo(): void {
  const cached = loadCachedServerInfo();
  if (!cached) return;
  const result = buildAppVersionCheckResult(cached);
  if (!result.upToDate || result.belowMinVersion || result.maintenance.enabled) {
    lastCheck = result;
  }
}

/**
 * Whether this process's version check has SETTLED - answered, fallen back to the cached verdict, or
 * skipped offline with it. `lastCheck` cannot say so: it stays `null` after a check that settled on
 * a non-blocking verdict. A surface that must never flash in front of a below-minimum gate (the
 * announcement drawn from the device) waits for this fact, not for a clock.
 */
let verdictSettled = $state(false);

/** See {@link verdictSettled}. Reactive. */
export function isVersionVerdictSettled(): boolean {
  return verdictSettled;
}

/** Latest version check result, or null before the first run. */
export function getAppVersionCheck(): AppVersionCheckResult | null {
  return lastCheck;
}

/**
 * True when the server reports a newer build than this client, without the client being
 * below the enforced minimum. Purely informational since the app stores handle updates:
 * it feeds the discreet "About" block in the settings page, and nothing interrupts the
 * user over it. When the client IS below the minimum, {@link isBelowMinClientVersion}
 * owns the case and blocks instead.
 */
export function isAppUpdateAvailable(): boolean {
  return lastCheck !== null && !lastCheck.upToDate && !lastCheck.belowMinVersion;
}

/**
 * The server's kill switch for calls as the last `/api/version` answer gave it, `off` before any
 * answer. Reactive (it reads the `$state` above), so a call button hides on the refresh that
 * closes calls. Read through `utils/callsAvailability.ts`, which joins it to the build switches.
 */
export function serverCallsMode(): CallsMode {
  return lastCheck?.callsMode ?? 'off';
}

/**
 * The server's group calls switch as the last `/api/version` answer gave it, `off` before any
 * answer. Reactive like {@link serverCallsMode}. A group conversation shows a call control only when
 * this reads `mesh` AND {@link serverCallsMode} is not `off`: the server refuses a group `initiate`
 * otherwise (403 `GROUP_CALLS_DISABLED`), so the client hides what would be refused.
 */
export function serverGroupCallsMode(): GroupCallsMode {
  return lastCheck?.groupCallsMode ?? 'off';
}

/**
 * The server's kill switch for lives as the last `/api/version` answer gave it, `off` before any
 * answer. Reactive like {@link serverCallsMode}, so the live card and the composer's Live chip hide
 * on the refresh that closes lives. Read through `utils/livesAvailability.ts`, which joins it to
 * the build switch.
 */
export function serverLivesMode(): LivesMode {
  return lastCheck?.livesMode ?? 'off';
}

/**
 * The server's live-replays switch as the last `/api/version` answer gave it, `off` before any
 * answer. Reactive like {@link serverLivesMode}. A CLIENT THAT READS `off` NEVER ASKS FOR A REPLAY
 * (`withReplays` is not sent) and draws none: the switch is the server's, the question is the
 * client's (`live/replayAvailability.ts`).
 */
export function serverLiveReplaysMode(): LiveReplaysMode {
  return lastCheck?.liveReplaysMode ?? 'off';
}

/**
 * The retention durations the server applies to new content, as the last `/api/version` answer gave
 * them - THE CACHED ANSWER COUNTS, for {@link serverPresencePost}'s reason (offline, `lastCheck` is
 * adopted only for a blocking verdict). `null` before any answer this session and from a server older
 * than the field. Read through `retentionInForce` (`$lib/legal/retention`), which says when it has to
 * show the defaults instead.
 */
export function serverRetention(): RetentionDays | null {
  if (lastCheck && lastCheck.serverVersion !== null) return lastCheck.retention;
  return loadCachedServerInfo()?.retention ?? null;
}

/**
 * The server's checkpoint-skip switch (WP-CHECKPOINT-SKIP) as the last LIVE `/api/version` answer of
 * THIS PROCESS gave it, `off` before one - `off` is the durability every client has always had. Read
 * through `receiveSkipBudgetFromServer` (`mls-client/receiveCheckpointSkip.ts`), which
 * `setupMessageHandler.ts` hands the state persister, at EVERY drain end. A switch moved at
 * `/admin/platform` reaches a running session at its next version check, which only focus, coming
 * back online and visibility trigger - there is no periodic refresh.
 *
 * NEVER THE CACHED ANSWER, unlike {@link serverPresencePost}: a cached `on` would outlive an emergency
 * `off` for as long as the session cache does, and only a weakened durability depends on it.
 */
export function serverCheckpointSkipMode(): CheckpointSkipMode {
  return liveCheckpointSkipMode;
}

/**
 * Whether this estate's gateway takes presence ids in a POST body, as the last `/api/version` answer
 * said - or `null` when no server has ever answered this session, which is "not known", never "no".
 * Read by `presenceStore.ts`, which asks nothing until it is known rather than guessing a route.
 *
 * THE CACHED ANSWER COUNTS. {@link lastCheck} is adopted from the cache only for a BLOCKING verdict
 * (offline, or a probe that failed its whole ladder), so a healthy cache plus one failed probe leaves
 * it `null` - and presence would go dark until the next focus. The cache is the same server's answer,
 * stored by this module, so it is read here whenever no live answer is held.
 */
export function serverPresencePost(): boolean | null {
  if (lastCheck && lastCheck.serverVersion !== null) return lastCheck.presencePost;
  return loadCachedServerInfo()?.presencePost ?? null;
}

/**
 * Whether this estate serves the background publish queue, as the last `/api/version` answer said -
 * or `null` when no server has ever answered, which is "not known", never "no". Read by
 * `publishQueue.svelte.ts`, which sends nothing until it is `true`. The cached answer counts, for
 * the reason {@link serverPresencePost} gives.
 */
export function serverPublishQueue(): boolean | null {
  if (lastCheck && lastCheck.serverVersion !== null) return lastCheck.publishQueue;
  return loadCachedServerInfo()?.publishQueue ?? null;
}

/**
 * Whether this estate builds forms as drafts (`formDrafts`), as the last `/api/version` answer said -
 * or `null` when no server has ever answered. The form editors use drafts only when it is `true`,
 * and save as before otherwise (docs/wiki/legacy-compatibility.md, "a form editor newer than its
 * server"). The cached answer counts, for the reason {@link serverPresencePost} gives.
 */
export function serverFormDrafts(): boolean | null {
  if (lastCheck && lastCheck.serverVersion !== null) return lastCheck.formDrafts;
  return loadCachedServerInfo()?.formDrafts ?? null;
}

/**
 * Whether this estate stores each priced grid's own "Obligatoire" switch (`gridRequiredSwitch`), as
 * the last `/api/version` answer said - or `null` when no server has ever answered. Read through
 * `gridRequiredSwitchOn` (`forms/gridRequiredGate.ts`): only `true` draws the switch and drops the
 * order rule (docs/wiki/legacy-compatibility.md, "a form editor or fill page newer than its server's
 * priced grids"). The cached answer counts, for the reason {@link serverPresencePost} gives.
 */
export function serverGridRequiredSwitch(): boolean | null {
  if (lastCheck && lastCheck.serverVersion !== null) return lastCheck.gridRequiredSwitch;
  return loadCachedServerInfo()?.gridRequiredSwitch ?? null;
}

/**
 * Whether this estate serves the ranked lists (`rankedFeeds`: Pour toi and the ranked CanaReels
 * viewer), as the last `/api/version` answer said - or `null` when no server has ever answered. Read
 * by `listPosts` (`posts/api.ts`, `rankedFeedsKnown`, which waits for the answer while it is `null`): only `true` asks them (docs/wiki/legacy-compatibility.md,
 * "a feed client newer than its server"). The cached answer counts, for the reason
 * {@link serverPresencePost} gives.
 */
export function serverRankedFeeds(): boolean | null {
  if (lastCheck && lastCheck.serverVersion !== null) return lastCheck.rankedFeeds;
  return loadCachedServerInfo()?.rankedFeeds ?? null;
}

/**
 * Whether this estate lets a respondent change their own answer (`formAnswerEdit`), as the last
 * `/api/version` answer said - or `null` when no server has ever answered. The form editors show the
 * switch, and the fill page asks for the caller's changeable answers, only when it is `true`: an
 * older server answers those routes `404` and strips the switch (docs/wiki/legacy-compatibility.md,
 * "an answer editor newer than its server"). The cached answer counts, for the reason
 * {@link serverPresencePost} gives.
 */
export function serverFormAnswerEdit(): boolean | null {
  if (lastCheck && lastCheck.serverVersion !== null) return lastCheck.formAnswerEdit;
  return loadCachedServerInfo()?.formAnswerEdit ?? null;
}

/**
 * Whether this estate stores an institution event's reach (`eventReach`), as the last
 * `/api/version` answer said - or `null` when no server has ever answered. The event form offers
 * the reach only when it is `true` (docs/wiki/legacy-compatibility.md, "an event form newer than
 * its server"). The cached answer counts, for the reason {@link serverPresencePost} gives.
 */
export function serverEventReach(): boolean | null {
  if (lastCheck && lastCheck.serverVersion !== null) return lastCheck.eventReach;
  return loadCachedServerInfo()?.eventReach ?? null;
}

/** True when the client is below the server-enforced minimum version. */
export function isBelowMinClientVersion(): boolean {
  return lastCheck?.belowMinVersion === true;
}

/** True when maintenance mode blocks the current user (non-global-admin). */
export function isMaintenanceBlockingCurrentUser(isGlobalAdmin: boolean): boolean {
  if (!lastCheck) return false;
  return isMaintenanceBlockingUser(lastCheck.maintenance, isGlobalAdmin);
}

/** Blocks MLS unlock (PIN/biometric) when min version or maintenance applies. */
export function shouldBlockSessionUnlock(isGlobalAdmin: boolean): boolean {
  if (isBelowMinClientVersion()) return true;
  return isMaintenanceBlockingCurrentUser(isGlobalAdmin);
}

/**
 * Calls `GET /api/version` and updates {@link getAppVersionCheck}.
 * Dedupes concurrent calls; retries on failure; uses cached metadata for instant UI.
 */
export async function refreshAppVersionCheck(): Promise<AppVersionCheckResult> {
  if (inflight) return inflight;

  // With no network the probe cannot answer, and its retry ladder (3 x 8 s timeouts plus backoff)
  // would sit in front of the unlock for ~26 s before falling back to exactly the cached verdict
  // returned here. The verdict is unchanged - only the wait is dropped.
  if (connectivity.isOffline) {
    const cached = buildAppVersionCheckResult(loadCachedServerInfo());
    if (!cached.upToDate || cached.belowMinVersion || cached.maintenance.enabled) {
      lastCheck = cached;
    }
    verdictSettled = true;
    return lastCheck ?? cached;
  }

  inflight = (async () => {
    try {
      const live = await fetchServerAppVersionReliable();
      const serverInfo = live ?? loadCachedServerInfo();

      if (live) {
        saveCachedServerInfo(live);
        liveCheckpointSkipMode = live.checkpointSkipMode;
      }

      lastCheck = buildAppVersionCheckResult(serverInfo);
      return lastCheck;
    } catch (e) {
      // A fallback is a signal: reaching this means /api/version stayed unreachable through the
      // whole retry ladder, and the verdict below is a cached one, not a measured one.
      console.warn(
        `[VERSION] /api/version unreachable, falling back to cached metadata: ${String(e)}`
      );
      const fallback = buildAppVersionCheckResult(loadCachedServerInfo());
      if (!fallback.upToDate || fallback.belowMinVersion || fallback.maintenance.enabled) {
        lastCheck = fallback;
      }
      return lastCheck ?? fallback;
    } finally {
      inflight = null;
      verdictSettled = true;
    }
  })();

  return inflight;
}

/**
 * THE CACHED VERDICT IS ADOPTED AT IMPORT; THE PROBE IS NOT FIRED HERE.
 *
 * Hydration is synchronous, touches only `localStorage` and is what lets a blocking verdict be
 * known before anything has rendered - so it stays, and every reader that says "the store hydrates
 * at import" is still right.
 *
 * **THE REFRESH USED TO FIRE HERE TOO, AND IT WAS A SECOND `GET /api/version` PER BOOT.** The root
 * layout already calls `refreshAppVersionCheck()` on mount, next to the `focus`, `online` and
 * `visibilitychange` listeners that refresh it afterwards - one place, readable, and the only one a
 * reader would look for. `inflight` dedupes CONCURRENT calls and nothing more, so the two requests
 * collided only when the second happened to be raised before the first answered; on production on
 * 2026-09-16 it did not, and the boot carried both. **The fix is to have one caller, not a window
 * in which two are tolerated** - a time-based guard here would be a clock deciding idempotence,
 * which is the one thing it must never decide.
 *
 * Nothing is delayed by this. The root layout's `onMount` is the same tick's worth of work away,
 * the verdict that gates the unlock is read from the hydrated cache long before either lands, and
 * `PlatformGateOverlay` raises itself from this same store whenever a later answer blocks.
 */
if (typeof window !== 'undefined') {
  hydrateFromCachedServerInfo();
}
