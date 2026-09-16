import {
  buildAppVersionCheckResult,
  fetchServerAppVersionReliable,
  isMaintenanceBlockingUser,
  parseServerVersionInfo,
  type AppVersionCheckResult,
} from '$lib/utils/appVersion';
import { connectivity } from '$lib/stores/connectivity.svelte';

const CACHED_SERVER_VERSION_KEY = 'canari:last_server_version_info';

let lastCheck = $state<AppVersionCheckResult | null>(null);
let inflight: Promise<AppVersionCheckResult> | null = null;

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
    sessionStorage.setItem(CACHED_SERVER_VERSION_KEY, JSON.stringify(info));
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
    return lastCheck ?? cached;
  }

  inflight = (async () => {
    try {
      const live = await fetchServerAppVersionReliable();
      const serverInfo = live ?? loadCachedServerInfo();

      if (live) {
        saveCachedServerInfo(live);
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
