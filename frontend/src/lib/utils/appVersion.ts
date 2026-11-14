import { coreUrl } from '$lib/utils/apiUrl';
import { MOBILE_APP_PACKAGE } from '$lib/mobile/appSiteAssociation';
import { parseRetention, type RetentionDays } from '$lib/legal/retention';
import { platform } from '@tauri-apps/plugin-os';

import { isTauriRuntime, openExternal } from '$lib/utils/openExternal';

/** GitHub repository where release artifacts (the Android APK) are published. */
export const CANARI_RELEASES_REPO = 'emse-students/canari';

/** Universal APK asset name on GitHub Releases (Android). */
export const CANARI_RELEASE_APK_FILENAME = 'app-universal-release.apk';

/**
 * Google Play listing URL for the Android build.
 *
 * A public, permanent URL - deliberately a constant rather than build-time config, so
 * an unset variable can never mean "update path silently dead". The `https://` form is
 * used over `market://details?id=...` because the Play Store app intercepts it on
 * device, it stays valid in a desktop browser, and it needs no `opener` ACL change.
 */
export const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${MOBILE_APP_PACKAGE}`;

/**
 * App Store listing URL for the iOS build.
 *
 * Geo-neutral on purpose (no `/us/` path segment): Apple redirects to the viewer's own
 * regional storefront. iOS updates always go through the App Store - there is no
 * sideloadable binary the way Android has its APK - so this is the only meaningful
 * update target on iOS.
 */
export const APP_STORE_URL = 'https://apps.apple.com/app/id6793060521';

/** Play Store package name of the Google Play installer itself. */
const PLAY_STORE_INSTALLER_PACKAGE = 'com.android.vending';

export type PlatformMaintenanceInfo = {
  enabled: boolean;
  message: string | null;
};

/**
 * The server's kill switch for calls (`platform_config.calls_mode`, published by `/api/version`):
 * `off` - no call may start; `audio` - audio only; `audio_video` - both. The server refuses what it
 * forbids on every call request; the client reads it only to HIDE what would be refused.
 */
export type CallsMode = 'off' | 'audio' | 'audio_video';

/**
 * Every value of {@link CallsMode}, for the admin picker and the agreement test. FIVE COPIES of these
 * three strings exist (the SQL CHECK, core's entity, chat-delivery's reader, this, the admin page
 * through this) and `callsModesAgree.test.ts` fails the day one of them drifts.
 */
export const CALLS_MODES: readonly CallsMode[] = ['off', 'audio', 'audio_video'];

/**
 * The server's kill switch for lives (`platform_config.lives_mode`, published by `/api/version`):
 * `off` - every live route answers 404; `on` - lives answer where the estate's `LIVE_ENABLED` deploy
 * lock is on too. The server refuses on every live request; the client reads it only to HIDE the
 * live surfaces that would be refused.
 */
export type LivesMode = 'off' | 'on';

/**
 * Every value of {@link LivesMode}. SIX COPIES of these two strings exist (the SQL CHECK, core's
 * entity, social-service's and media-service's readers, this, the admin page through this) and
 * `livesModesAgree.test.ts` fails the day one of them drifts.
 */
export const LIVES_MODES: readonly LivesMode[] = ['off', 'on'];

/**
 * The server's switch for WP-CHECKPOINT-SKIP (`platform_config.checkpoint_skip_mode`, published by
 * `/api/version`): `off` - every drain ends with a full MLS checkpoint, as always; `on` - a live drain
 * that only received application frames leaves it to the next existing trigger, up to the client's
 * own count (`mls-client/receiveCheckpointSkip.ts`). Nothing on the server enforces it: it is this
 * client's own durability, so the client is the only reader.
 */
export type CheckpointSkipMode = 'off' | 'on';

/**
 * Every value of {@link CheckpointSkipMode}. FOUR COPIES of these two strings exist (the SQL CHECK,
 * core's entity, this, the admin page through this) and `checkpointSkipModesAgree.test.ts` fails the
 * day one of them drifts.
 */
export const CHECKPOINT_SKIP_MODES: readonly CheckpointSkipMode[] = ['off', 'on'];

/**
 * The server's switch for live replays (`platform_config.live_replays_mode`, published by
 * `/api/version` as `liveReplays.mode`): `off` - a live is deleted at its end; `on` - a live started
 * now is kept three days as a replay. Enforced by social-service at the START of a live, which fixes
 * it on the live row; this client names it for the admin page (docs/wiki/live-replays.md).
 */
export type LiveReplaysMode = 'off' | 'on';

/**
 * Every value of {@link LiveReplaysMode}. FIVE COPIES of these two strings exist (the SQL CHECK,
 * core's entity, social-service's reader, this, the admin page through this) and
 * `liveReplaysModesAgree.test.ts` fails the day one of them drifts.
 */
export const LIVE_REPLAYS_MODES: readonly LiveReplaysMode[] = ['off', 'on'];

/**
 * The server's switch for group calls (`platform_config.group_calls_mode`, published by
 * `/api/version` as `calls.groupMode`): `off` - a group conversation shows no call control and the
 * server refuses a group `initiate` (403 `GROUP_CALLS_DISABLED`); `mesh` - group calls go peer to
 * peer, up to 4 participants in audio and 3 in video. `callsMode = off` still closes everything.
 */
export type GroupCallsMode = 'off' | 'mesh';

/**
 * Every value of {@link GroupCallsMode}. FIVE COPIES of these two strings exist (the SQL CHECK,
 * core's entity, chat-delivery's reader, this, the admin page through this) and
 * `groupCallsModesAgree.test.ts` fails the day one of them drifts.
 */
export const GROUP_CALLS_MODES: readonly GroupCallsMode[] = ['off', 'mesh'];

/**
 * Which relay carries a group call (`platform_config.call_relay`, published by `/api/version` as
 * `calls.relay`, WP-GC4): `none` - the mesh, refused past its cap; `call-service` - our SFU carries
 * the group call from the start (the server signs `mode: sfu` into its room tokens). An absent or
 * unknown value reads `none`.
 */
export type CallRelay = 'none' | 'call-service';

/**
 * Every value of {@link CallRelay}. Five copies of these strings exist (the SQL CHECK, core's
 * entity, chat-delivery's reader, this, the admin page through this) and `callRelaysAgree.test.ts`
 * fails the day one of them drifts.
 */
export const CALL_RELAYS: readonly CallRelay[] = ['none', 'call-service'];

export type ServerVersionInfo = {
  version: string;
  minClientVersion: string;
  maintenance: PlatformMaintenanceInfo;
  callsMode: CallsMode;
  groupCallsMode: GroupCallsMode;
  callRelay: CallRelay;
  livesMode: LivesMode;
  liveReplaysMode: LiveReplaysMode;
  checkpointSkipMode: CheckpointSkipMode;
  /** Whether this core-service redeems a code with a PKCE verifier - see {@link AppVersionCheckResult}. */
  oidcPkce: boolean;
  /** Whether this estate's gateway takes presence ids in a POST body - see {@link AppVersionCheckResult}. */
  presencePost: boolean;
  /** Whether this estate serves the background publish queue - see {@link AppVersionCheckResult}. */
  publishQueue: boolean;
  /** Whether this estate builds forms as drafts - see {@link AppVersionCheckResult}. */
  formDrafts: boolean;
  /** Whether this estate stores each priced grid's own switch - see {@link AppVersionCheckResult}. */
  gridRequiredSwitch: boolean;
  /** Whether this estate serves the ranked lists - see {@link AppVersionCheckResult}. */
  rankedFeeds: boolean;
  /** Whether this estate lets a respondent change their answer - see {@link AppVersionCheckResult}. */
  formAnswerEdit: boolean;
  /** Whether this estate stores an institution event's reach - see {@link AppVersionCheckResult}. */
  eventReach: boolean;
  /** The retention durations in force (`retention`), `null` from a server older than the field. */
  retention: RetentionDays | null;
};

export type AppVersionCheckResult = {
  clientVersion: string;
  serverVersion: string | null;
  minClientVersion: string | null;
  upToDate: boolean;
  /** True when the client is older than the server-enforced minimum. */
  belowMinVersion: boolean;
  maintenance: PlatformMaintenanceInfo;
  /** What the server lets calls do; `off` until a server has said otherwise. */
  callsMode: CallsMode;
  /** Whether a group conversation may call (`calls.groupMode`); `off` until a server has said otherwise. */
  groupCallsMode: GroupCallsMode;
  /** Which relay carries a group call (`calls.relay`); `none` until a server has said otherwise. */
  callRelay: CallRelay;
  /** Whether the server lets lives answer; `off` until a server has said otherwise. */
  livesMode: LivesMode;
  /** Whether lives are kept as replays (the client asks for them only then); `off` until a server has said otherwise. */
  liveReplaysMode: LiveReplaysMode;
  /** Whether a receive-only drain may defer its MLS checkpoint; `off` until a server has said otherwise. */
  checkpointSkipMode: CheckpointSkipMode;
  /**
   * A CAPABILITY of the server, not a switch: core-service forwards a PKCE `code_verifier` to
   * MiConnect. `startOidcLogin` sends a `code_challenge` only when this is true, because an older
   * core-service drops the verifier and MiConnect refuses a challenged code redeemed without it.
   * `false` until a server has said so, and for every server older than the field.
   */
  oidcPkce: boolean;
  /**
   * A CAPABILITY of the estate, not a switch: its chat-gateway answers `POST /api/presence` with
   * the ids in the body. `presenceStore.ts` sends the POST only when this is true, because an older
   * gateway answers it 405 and a store build reaches phones before production deploys. `false` for
   * every server older than the field.
   */
  presencePost: boolean;
  /**
   * A CAPABILITY of the estate, not a switch: social-service keeps a post's client id and serves its
   * withdrawal, media-service opens `single-block` sessions. The publish queue sends nothing until
   * this is true, because an older estate would duplicate a post whose answer was lost and answer the
   * withdrawal `404` - and a store build reaches phones before production deploys. `false` for every
   * server older than the field.
   */
  publishQueue: boolean;
  /**
   * A CAPABILITY of the estate, not a switch: social-service creates a form as a draft, publishes it
   * by its own route and keeps its unpublished revision. The form editors use drafts only when this
   * is true, and otherwise save as before: an older server strips `draft` and publishes the form at
   * once, and answers the revision routes `404` - and a store build reaches phones before production
   * deploys. `false` for every server older than the field.
   */
  formDrafts: boolean;
  /**
   * A CAPABILITY of the estate, not a switch: social-service stores each priced grid's own
   * "Obligatoire" switch and demands a unit only of a REQUIRED grid, with no rule over the whole
   * order (owner, 2026-11-13). The editor draws the switch, and the fill pages drop the order rule,
   * only when this is true: an older server refuses a grid sent optional
   * (`PRODUCT_GRID_NOT_REQUIRED`) and demands one unit across the order (`PRODUCT_GRID_EMPTY`) - and
   * a store build reaches phones before production deploys. `false` for every server older than the
   * field.
   */
  gridRequiredSwitch: boolean;
  /**
   * Whether this estate's social-service serves the RANKED lists (`rankedFeeds`): Pour toi
   * (`feed=foryou`) and the CanaReels viewer asked `ranked=true`, with their `asOf` pages. An older
   * one refuses `feed=foryou` `400` and drops `ranked` - and a store build reaches phones before
   * production deploys. `false` for every server older than the field.
   */
  rankedFeeds: boolean;
  /**
   * Whether this estate's social-service lets a respondent change their own answer
   * (`formAnswerEdit`, migration 166). An older one answers the answer routes `404` and strips the
   * form's switch from a save - and a store build reaches phones before production deploys, so the
   * switch and "Modifier ma reponse" are offered only when this is true. `false` for every server
   * older than the field.
   */
  formAnswerEdit: boolean;
  /**
   * A CAPABILITY of the estate, not a switch: social-service stores an institution calendar event's
   * reach and serves its options route. The event form draws the reach picker, and requires a
   * choice, only when this is true: an older server answers the options route `404` and cannot store
   * a reach, so requiring one there would block every institution's event - and a store build
   * reaches phones before production deploys. `false` for every server older than the field.
   */
  eventReach: boolean;
  /**
   * The retention durations the server applies to new content (`retention`, core migration 025),
   * which the privacy policy and the live texts render; `null` until a server has said so, and for
   * every server older than the field ({@link import('$lib/legal/retention').retentionInForce}).
   */
  retention: RetentionDays | null;
};

const DEFAULT_MAINTENANCE: PlatformMaintenanceInfo = { enabled: false, message: null };

function normalizeMaintenance(raw: unknown): PlatformMaintenanceInfo {
  if (!raw || typeof raw !== 'object') return DEFAULT_MAINTENANCE;
  const obj = raw as { enabled?: unknown; message?: unknown };
  return {
    enabled: obj.enabled === true,
    message: typeof obj.message === 'string' && obj.message.trim() ? obj.message.trim() : null,
  };
}

/**
 * The calls mode a `/api/version` body carries. ABSENT OR UNKNOWN READS AS `off`: a server that does
 * not publish the switch is one this client cannot ask, and the failure of a kill switch must be
 * the closed direction - the server would refuse anyway, so showing a call button would only buy a
 * refusal toast.
 */
function normalizeCallsMode(raw: unknown): CallsMode {
  const mode = raw && typeof raw === 'object' ? (raw as { mode?: unknown }).mode : undefined;
  return CALLS_MODES.find((known) => known === mode) ?? 'off';
}

/**
 * The group calls mode a `/api/version` body carries (`calls.groupMode`). ABSENT OR UNKNOWN READS AS
 * `off`, for the reason {@link normalizeCallsMode} gives: a switch that cannot be read fails closed,
 * and a server that predates it refuses group calls anyway.
 */
function normalizeGroupCallsMode(raw: unknown): GroupCallsMode {
  const mode =
    raw && typeof raw === 'object' ? (raw as { groupMode?: unknown }).groupMode : undefined;
  return GROUP_CALLS_MODES.find((known) => known === mode) ?? 'off';
}

/**
 * The call relay a `/api/version` body carries (`calls.relay`). ABSENT OR UNKNOWN READS AS `none`:
 * a server that predates it has no relay for group calls.
 */
function normalizeCallRelay(raw: unknown): CallRelay {
  const relay = raw && typeof raw === 'object' ? (raw as { relay?: unknown }).relay : undefined;
  return CALL_RELAYS.find((known) => known === relay) ?? 'none';
}

/**
 * The lives mode a `/api/version` body carries. ABSENT OR UNKNOWN READS AS `off`, for the reason
 * {@link normalizeCallsMode} gives: a kill switch that cannot be read fails closed.
 */
function normalizeLivesMode(raw: unknown): LivesMode {
  const mode = raw && typeof raw === 'object' ? (raw as { mode?: unknown }).mode : undefined;
  return LIVES_MODES.find((known) => known === mode) ?? 'off';
}

/**
 * The live-replays mode a `/api/version` body carries (`liveReplays.mode`). ABSENT OR UNKNOWN READS
 * AS `off`: a server that does not publish the switch has no replay, and the client then never asks
 * for one (`withReplays` is sent only when this reads `on`).
 */
function normalizeLiveReplaysMode(raw: unknown): LiveReplaysMode {
  const mode = raw && typeof raw === 'object' ? (raw as { mode?: unknown }).mode : undefined;
  return LIVE_REPLAYS_MODES.find((known) => known === mode) ?? 'off';
}

/**
 * The checkpoint-skip mode a `/api/version` body carries. ABSENT OR UNKNOWN READS AS `off`: `off` is
 * the behaviour every client has always had, so a server that does not publish the switch - or a
 * value this client does not know - can only ever mean today's durability.
 */
function normalizeCheckpointSkipMode(raw: unknown): CheckpointSkipMode {
  const mode = raw && typeof raw === 'object' ? (raw as { mode?: unknown }).mode : undefined;
  return CHECKPOINT_SKIP_MODES.find((known) => known === mode) ?? 'off';
}

/** Parses `/api/version` JSON into a normalized {@link ServerVersionInfo}. */
export function parseServerVersionInfo(data: unknown): ServerVersionInfo | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as {
    version?: unknown;
    minClientVersion?: unknown;
    maintenance?: unknown;
    calls?: unknown;
    liveReplays?: unknown;
    lives?: unknown;
    checkpointSkip?: unknown;
    oidcPkce?: unknown;
    presencePost?: unknown;
    publishQueue?: unknown;
    formDrafts?: unknown;
    gridRequiredSwitch?: unknown;
    rankedFeeds?: unknown;
    formAnswerEdit?: unknown;
    eventReach?: unknown;
    retention?: unknown;
  };
  const version = typeof obj.version === 'string' ? obj.version.trim() : '';
  if (!version) return null;
  const minRaw = typeof obj.minClientVersion === 'string' ? obj.minClientVersion.trim() : '';
  return {
    version,
    minClientVersion: minRaw || '0.0.0',
    maintenance: normalizeMaintenance(obj.maintenance),
    callsMode: normalizeCallsMode(obj.calls),
    groupCallsMode: normalizeGroupCallsMode(obj.calls),
    callRelay: normalizeCallRelay(obj.calls),
    livesMode: normalizeLivesMode(obj.lives),
    liveReplaysMode: normalizeLiveReplaysMode(obj.liveReplays),
    checkpointSkipMode: normalizeCheckpointSkipMode(obj.checkpointSkip),
    oidcPkce: obj.oidcPkce === true,
    presencePost: obj.presencePost === true,
    publishQueue: obj.publishQueue === true,
    formDrafts: obj.formDrafts === true,
    gridRequiredSwitch: obj.gridRequiredSwitch === true,
    rankedFeeds: obj.rankedFeeds === true,
    formAnswerEdit: obj.formAnswerEdit === true,
    eventReach: obj.eventReach === true,
    retention: parseRetention(obj.retention),
  };
}

/**
 * The `/api/version` body a {@link ServerVersionInfo} came from - its inverse, so a cached copy is
 * stored in the SAME shape it is read back with. Storing the parsed shape instead (`callsMode` at
 * the top) and re-parsing it with {@link parseServerVersionInfo} (which reads `calls.mode`) read
 * every cached mode back as `off`.
 */
export function serverVersionInfoToWire(info: ServerVersionInfo): {
  version: string;
  minClientVersion: string;
  maintenance: PlatformMaintenanceInfo;
  calls: { mode: CallsMode; groupMode: GroupCallsMode; relay: CallRelay };
  lives: { mode: LivesMode };
  liveReplays: { mode: LiveReplaysMode };
  checkpointSkip: { mode: CheckpointSkipMode };
  oidcPkce: boolean;
  presencePost: boolean;
  publishQueue: boolean;
  formDrafts: boolean;
  gridRequiredSwitch: boolean;
  rankedFeeds: boolean;
  formAnswerEdit: boolean;
  eventReach: boolean;
  retention?: RetentionDays;
} {
  return {
    version: info.version,
    minClientVersion: info.minClientVersion,
    maintenance: info.maintenance,
    calls: { mode: info.callsMode, groupMode: info.groupCallsMode, relay: info.callRelay },
    lives: { mode: info.livesMode },
    liveReplays: { mode: info.liveReplaysMode },
    checkpointSkip: { mode: info.checkpointSkipMode },
    oidcPkce: info.oidcPkce,
    presencePost: info.presencePost,
    publishQueue: info.publishQueue,
    formDrafts: info.formDrafts,
    gridRequiredSwitch: info.gridRequiredSwitch,
    rankedFeeds: info.rankedFeeds,
    formAnswerEdit: info.formAnswerEdit,
    eventReach: info.eventReach,
    ...(info.retention ? { retention: info.retention } : {}),
  };
}
/**
 * The version this device reports when it enrols.
 *
 * A BUILD-TIME FACT, ASKED WHERE IT IS KNOWN. This used to be `getVersion()` from
 * `@tauri-apps/api/app` behind a cache, and on iOS it answered empty - so 168 of 226 iPhones
 * active in the 30 days to 2026-09-14 had enrolled with no version at all, and `minClientVersion`
 * is raised by hand against exactly this column. Nothing about a version needs a runtime round
 * trip: the app EMBEDS this bundle (`frontendDist: "../build"`), so the bundle's own constant IS
 * the app's version on every platform, and it cannot fail.
 *
 * IT IS ALSO THE VERSION THE GATE ACTUALLY COMPARES. `minClientVersion` is checked against
 * `VITE_APP_VERSION`, which is what `getClientAppVersion()` returns; the native shell's version is
 * a different string that merely happens to agree because one script writes both. Reporting the
 * one the gate reads makes the column evidence about the decision it feeds - including the
 * `0.0.0` this returns when the constant is absent, which is not a placeholder standing in for
 * `unknown`: it is what the gate itself would compare, so a device recorded at `0.0.0` is
 * precisely a device any floor will block.
 */
export function getClientAppVersion(): string {
  const v = import.meta.env.VITE_APP_VERSION?.trim();
  return v || '0.0.0';
}

/**
 * THE HEADER A CALL NAMES THIS BUILD IN, for a server that answers each build what it can use: the
 * lives routes (a build below their floor is answered like a switched-off estate) and the
 * notifications read (only the types this build draws - social-service's
 * `notification-client-floor.ts`). ONE spelling for every caller; the value is
 * {@link getClientAppVersion}, the version the update gate compares too.
 */
export const CLIENT_VERSION_HEADER = 'X-Canari-Client-Version';

/** `headers` with this build named in {@link CLIENT_VERSION_HEADER}. */
export function withClientVersionHeader(
  headers: Record<string, string> = {}
): Record<string, string> {
  return { ...headers, [CLIENT_VERSION_HEADER]: getClientAppVersion() };
}

/**
 * Splits a version into the numeric core and the pre-release identifiers that decide ties.
 *
 * Build metadata is dropped here and nowhere else: semver gives `+...` no part in precedence, and
 * `deploy-build.ts` is the reason a `+` should never reach this function at all.
 */
function semverParts(version: string): { core: number[]; pre: string[] } {
  const withoutBuild = version.trim().split('+', 1)[0] ?? '';
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1);
  return {
    core: core.split('.').map((n) => parseInt(n, 10) || 0),
    pre: pre ? pre.split('.') : [],
  };
}

/**
 * Compares two semver strings by PRECEDENCE, pre-releases included.
 *
 * WHY THE PRE-RELEASE HALF EXISTS. Until 2026-09-03 every release here was a bare
 * `major.minor.patch`, and this function split on `.` and `parseInt`ed the pieces. The
 * deploy-at-bump model introduced `X.Y.Z-alpha.N` to feed the store tester channels, and that shape
 * broke the naive version IN THE REASSURING DIRECTION: `parseInt('0-alpha')` is `0`, so
 * `0.15.0-alpha.1` read as `[0, 15, 0, 1]` and compared ABOVE its own stable `0.15.0`. A tester
 * would have considered themselves newer than the release they were testing for and never been
 * offered it - a population stuck on a pre-release for ever, with nothing to say so. The same bug
 * made `-alpha.1` and `-beta.1` compare EQUAL, the suffix contributing nothing at all.
 *
 * Semver 2.0.0 precedence, in the order applied: the numeric core; then a version WITH a
 * pre-release ranks BELOW the same core without one; then the identifiers left to right, numeric
 * ones compared numerically, the rest ASCII-lexically, numeric ranking below alphanumeric, and a
 * shorter identifier list losing once every shared identifier is equal.
 *
 * @returns negative if a < b, positive if a > b, else 0
 */
export function compareSemver(a: string, b: string): number {
  const va = semverParts(a);
  const vb = semverParts(b);

  const len = Math.max(va.core.length, vb.core.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  // Equal cores: the one carrying a pre-release is the earlier version.
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1;
  if (vb.pre.length === 0) return -1;

  const preLen = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < preLen; i++) {
    const ia = va.pre[i];
    const ib = vb.pre[i];
    // Running out of identifiers first is ranking lower - `alpha` precedes `alpha.1`.
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    if (ia === ib) continue;

    const aNumeric = /^\d+$/.test(ia);
    const bNumeric = /^\d+$/.test(ib);
    if (aNumeric && bNumeric) {
      const diff = parseInt(ia, 10) - parseInt(ib, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // A numeric identifier always ranks below an alphanumeric one.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return ia < ib ? -1 : 1;
  }
  return 0;
}

const VERSION_FETCH_TIMEOUT_MS = 8_000;
const VERSION_FETCH_RETRIES = 3;
const VERSION_RETRY_DELAY_MS = 1_200;

/** Fetches `GET /api/version` (no auth). */
export async function fetchServerAppVersion(
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<ServerVersionInfo | null> {
  try {
    const res = await fetchFn(`${coreUrl()}/api/version`, {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    return parseServerVersionInfo(data);
  } catch {
    return null;
  }
}

/** Retries `/api/version` with per-attempt timeout (mobile cold start / slow networks). */
export async function fetchServerAppVersionReliable(
  fetchFn: typeof fetch = fetch
): Promise<ServerVersionInfo | null> {
  for (let attempt = 0; attempt < VERSION_FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS);
    try {
      const info = await fetchServerAppVersion(fetchFn, controller.signal);
      if (info) return info;
    } catch {
      /* timeout or network - retry */
    } finally {
      clearTimeout(timer);
    }
    if (attempt < VERSION_FETCH_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, VERSION_RETRY_DELAY_MS));
    }
  }
  return null;
}

/** Builds a version check result from server metadata (or null fields when unknown). */
export function buildAppVersionCheckResult(
  serverInfo: ServerVersionInfo | null
): AppVersionCheckResult {
  const clientVersion = getClientAppVersion();
  const serverVersion = serverInfo?.version ?? null;
  const minClientVersion = serverInfo?.minClientVersion ?? null;
  const maintenance = serverInfo?.maintenance ?? DEFAULT_MAINTENANCE;
  const upToDate = serverVersion === null || compareSemver(clientVersion, serverVersion) >= 0;
  const belowMinVersion =
    minClientVersion !== null && compareSemver(clientVersion, minClientVersion) < 0;
  return {
    clientVersion,
    serverVersion,
    minClientVersion,
    upToDate,
    belowMinVersion,
    maintenance,
    callsMode: serverInfo?.callsMode ?? 'off',
    groupCallsMode: serverInfo?.groupCallsMode ?? 'off',
    callRelay: serverInfo?.callRelay ?? 'none',
    livesMode: serverInfo?.livesMode ?? 'off',
    liveReplaysMode: serverInfo?.liveReplaysMode ?? 'off',
    checkpointSkipMode: serverInfo?.checkpointSkipMode ?? 'off',
    oidcPkce: serverInfo?.oidcPkce ?? false,
    presencePost: serverInfo?.presencePost ?? false,
    publishQueue: serverInfo?.publishQueue ?? false,
    formDrafts: serverInfo?.formDrafts ?? false,
    gridRequiredSwitch: serverInfo?.gridRequiredSwitch ?? false,
    rankedFeeds: serverInfo?.rankedFeeds ?? false,
    formAnswerEdit: serverInfo?.formAnswerEdit ?? false,
    eventReach: serverInfo?.eventReach ?? false,
    retention: serverInfo?.retention ?? null,
  };
}

/** True when maintenance is active and the caller is not a global admin. */
export function isMaintenanceBlockingUser(
  maintenance: PlatformMaintenanceInfo,
  isGlobalAdmin: boolean
): boolean {
  return maintenance.enabled && !isGlobalAdmin;
}

/** Normalizes a semver string to a GitHub release tag (`vX.Y.Z`). */
export function releaseTag(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/**
 * Direct APK download URL for a release (`/releases/download/vX.Y.Z/app-universal-release.apk`).
 * Falls back to `/releases/latest/download/…` when version is unknown.
 */
export function getReleaseApkDownloadUrl(version: string | null): string {
  const base = `https://github.com/${CANARI_RELEASES_REPO}/releases`;
  const trimmed = version?.trim();
  if (!trimmed) {
    return `${base}/latest/download/${CANARI_RELEASE_APK_FILENAME}`;
  }
  return `${base}/download/${releaseTag(trimmed)}/${CANARI_RELEASE_APK_FILENAME}`;
}

/**
 * URL of the GitHub release page for a given semver (tag `vX.Y.Z`).
 * Falls back to `/releases/latest` when version is unknown.
 */
export function getReleasePageUrl(version: string | null): string {
  const base = `https://github.com/${CANARI_RELEASES_REPO}/releases`;
  const trimmed = version?.trim();
  if (!trimmed) return `${base}/latest`;
  return `${base}/tag/${releaseTag(trimmed)}`;
}

/**
 * The OS this build was COMPILED for, or `null` on the web, where there is no native side.
 *
 * Never read from `navigator.userAgent`: an iPad answers that question with "Macintosh".
 * Desktop-class browsing is WKWebView's default content mode (`preferredContentMode`
 * `.recommended`) for any view wider than 375 px, so `/iphone|ipad|ipod/` - which is how this
 * file used to decide - was FALSE on every iPad. The app then took the web branch of each iOS
 * decision, starting with the OIDC redirect URI: an iPad asked Authentik to redirect to
 * `tauri://localhost/auth/callback` instead of `fr.emse.canari://callback`, and was refused.
 * That is the "Redirect URI Error" App Review hit on an iPad Air on 2026-08-30.
 *
 * `platform()` is a compile-time constant published by tauri-plugin-os into the WebView, so it
 * is synchronous like the regexes it replaces, and it cannot be wrong about the device class.
 * It THROWS in a Tauri runtime where the plugin is not registered - deliberately: a platform
 * this app cannot name must be loud, never silently "not mobile".
 */
function nativePlatform(): string | null {
  if (!isTauriRuntime()) return null;
  return platform();
}

/**
 * The platform this build runs on, as the gateway's anonymous census counts it: `web` in a browser,
 * else the native shell's own name (`android`, `ios`, `macos`, `windows`, `linux`). Sent on the
 * socket URL beside {@link getClientAppVersion}, and attached to no identity.
 */
export function clientPlatform(): string {
  return nativePlatform() ?? 'web';
}

/** True on Tauri Android builds (universal APK update flow). Phones and tablets alike. */
export function isAndroidTauriRuntime(): boolean {
  return nativePlatform() === 'android';
}

/** True on Tauri iOS builds (App Store update flow, no direct binary download). iPhone AND iPad. */
export function isIosTauriRuntime(): boolean {
  return nativePlatform() === 'ios';
}

/**
 * True on any native mobile Tauri build (Android or iOS). Use this for logic that
 * must run wherever a native background engine advances `mls.bin` and posts its own
 * OS notifications - both platforms do (Android via CanariFirebaseMessagingService,
 * iOS via canari_push.mm) - as opposed to Android-only APK/update concerns.
 */
export function isMobileTauriRuntime(): boolean {
  return isAndroidTauriRuntime() || isIosTauriRuntime();
}

/**
 * How this Android install arrived, which decides where its updates can come from.
 *
 * The Play build is signed by Google Play App Signing; the GitHub `app-universal-release.apk`
 * is signed with our upload key. The two signatures differ, so NEITHER build can install
 * over the other - sending a sideload user to the Play Store hands them an install Android
 * will refuse. The target is therefore a runtime fact, never a build-time constant.
 */
export type AndroidInstallSource = 'play' | 'sideload';

/** Where an update prompt sends the user, and which wording that target needs. */
export type UpdateTargetKind = 'play' | 'appstore' | 'apk' | 'releasePage' | 'reload';

export type UpdateTarget = {
  kind: UpdateTargetKind;
  /** Empty for `reload`, which is a `window.location.reload()` rather than a navigation. */
  url: string;
};

/** Runtime platform facts {@link buildUpdateTarget} decides from. Injectable for tests. */
export type UpdatePlatform = {
  android: boolean;
  ios: boolean;
  native: boolean;
};

/** Reads the current runtime into an {@link UpdatePlatform}. */
export function currentUpdatePlatform(): UpdatePlatform {
  return {
    android: isAndroidTauriRuntime(),
    ios: isIosTauriRuntime(),
    native: isTauriRuntime(),
  };
}

/**
 * Pure mapping from platform + install source to an update destination.
 *
 * Split from the probe below so the decision itself is unit-testable without a Tauri
 * runtime: Android goes to Play or to the matching APK depending on how it was installed,
 * iOS always to the App Store, other native builds to the GitHub release page, and the
 * web to a plain reload (the browser then fetches the deployed bundle).
 */
export function buildUpdateTarget(
  serverVersion: string | null,
  platform: UpdatePlatform,
  installSource: AndroidInstallSource
): UpdateTarget {
  if (platform.android) {
    return installSource === 'play'
      ? { kind: 'play', url: PLAY_STORE_URL }
      : { kind: 'apk', url: getReleaseApkDownloadUrl(serverVersion) };
  }
  if (platform.ios) {
    return { kind: 'appstore', url: APP_STORE_URL };
  }
  if (platform.native) {
    return { kind: 'releasePage', url: getReleasePageUrl(serverVersion) };
  }
  return { kind: 'reload', url: '' };
}

/** Memoized: the install source cannot change while the process lives. */
let installSourceProbe: Promise<AndroidInstallSource> | null = null;

/**
 * Asks the native side which package installed this app (`installer_package.txt`, written
 * by `CanariApplication.onCreate`) and maps it to an {@link AndroidInstallSource}.
 *
 * Defaults to `'play'` when the probe fails AND LOGS IT: every build carrying this code
 * writes that file at startup, so a miss is a real fault rather than an expected state,
 * and Play is the correct assumption for every install made from now on.
 */
export async function probeAndroidInstallSource(): Promise<AndroidInstallSource> {
  installSourceProbe ??= (async (): Promise<AndroidInstallSource> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const installer = (await invoke<string | null>('get_installer_package'))?.trim();
      if (!installer) {
        console.warn(
          '[appVersion] installer package unknown (empty or missing installer_package.txt) - assuming Play Store'
        );
        return 'play';
      }
      console.debug(`[appVersion] install source: ${installer}`);
      return installer === PLAY_STORE_INSTALLER_PACKAGE ? 'play' : 'sideload';
    } catch (e) {
      console.warn('[appVersion] get_installer_package failed - assuming Play Store:', e);
      return 'play';
    }
  })();
  return installSourceProbe;
}

/**
 * Resolves where this specific install must be sent to update. Probes the Android install
 * source; every other platform has a single possible target, so it skips the round trip.
 */
export async function resolveUpdateTarget(serverVersion: string | null): Promise<UpdateTarget> {
  const platform = currentUpdatePlatform();
  const installSource = platform.android ? await probeAndroidInstallSource() : 'play';
  return buildUpdateTarget(serverVersion, platform, installSource);
}

/**
 * Opens the resolved update target (Play Store or matching APK on Android, App Store on
 * iOS, release page on desktop Tauri), or reloads the web app so the browser fetches the
 * deployed bundle.
 */
export async function openLatestAppUpdate(serverVersion: string | null): Promise<void> {
  const target = await resolveUpdateTarget(serverVersion);
  if (target.kind === 'reload') {
    window.location.reload();
    return;
  }
  await openExternal(target.url);
}
