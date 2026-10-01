/**
 * What a web tab does when a lazy module fails to load because a deploy replaced the build under it.
 *
 * Every `import()` in the app is a request for a hashed chunk of THE BUILD THE TAB BOOTED ON. A
 * deploy deletes those chunks, so a tab left open across one can no longer load any module it had
 * not already loaded - measured on production 2026-09-27: a tab opened on `0.18.26` three minutes
 * before `v0.18.27` landed, then the carte's PDF export failed with a bare "Erreur" and
 * `Failed to fetch dynamically imported module`, its chunk a 404 on the new build.
 *
 * SvelteKit already covers its OWN route chunks (a navigation that fails to load checks
 * `version.json` and falls back to a full page load). Nothing covered the app's own `import()`s, and
 * this is that cover. It never retries the chunk - the chunk is GONE, not slow - and it never reloads
 * on its own: a reload discards whatever the reader was doing, so it OFFERS one, which is the safe
 * point the reader chooses.
 *
 * THE TRIGGER IS A TYPED EVENT, NEVER A MESSAGE. Vite's preload helper wraps every dynamic import in
 * the build and dispatches `vite:preloadError` when one (or a CSS file it needs) fails - the
 * distinction carried as a type at the throw, which an error's prose is not.
 *
 * THE BUILD IS KNOWN FROM A FACT, NOT INFERRED FROM THE FAILURE. A chunk that fails to load is a
 * symptom shared by a deploy and by a dead network, so the decision reads `/_app/version.json` - the
 * build the server serves NOW - against the build this tab runs. Only a difference is a reason to
 * reload.
 *
 * ONCE PER BUILD, FROM DURABLE STATE, NEVER A CLOCK. The build a reload was accepted FOR is written
 * to `sessionStorage` (the tab's lifetime, which survives the reload itself) before reloading. If
 * the reloaded page still runs the old build - a cached shell, a proxy - the next failure finds that
 * build already recorded and says so at ERROR instead of offering the same reload for ever. A newer
 * deploy is a different build, so it is offered again, which is correct.
 *
 * Tauri is not covered and needs nothing: the app EMBEDS its frontend, so a deploy never reaches it.
 */

/** `sessionStorage` key holding the served build a reload was last accepted for. */
export const STALE_BUILD_RELOADED_FOR_KEY = 'canari:stale-build:reloaded-for';

/**
 * What a failed lazy load means, once the served build is known.
 *
 * - `offer-reload`: the server serves another build than this tab runs; reloading fixes it.
 * - `already-reloaded`: it does, but a reload toward that very build was already taken and this tab
 *   still runs the old one - reloading again would loop.
 * - `same-build`: the server serves this tab's own build, so the chunk failed for another reason (a
 *   transport failure, or a defect) and a reload would hide it.
 * - `unknown`: the served build could not be read, which is evidence about the network, not the build.
 */
export type StaleBuildVerdict =
  | { kind: 'offer-reload'; servedVersion: string }
  | { kind: 'already-reloaded'; servedVersion: string }
  | { kind: 'same-build' }
  | { kind: 'unknown' };

/**
 * Decides what a failed lazy load calls for. Pure, so every branch is a test.
 *
 * @param runningVersion - the build this tab booted on (`$app/environment`'s `version`).
 * @param servedVersion - the build `version.json` names now, or `null` when it could not be read.
 * @param reloadedFor - the served build a reload was already accepted for in this tab, if any.
 */
export function judgeStaleBuild(
  runningVersion: string,
  servedVersion: string | null,
  reloadedFor: string | null
): StaleBuildVerdict {
  if (servedVersion === null) return { kind: 'unknown' };
  if (servedVersion === runningVersion) return { kind: 'same-build' };
  if (reloadedFor === servedVersion) return { kind: 'already-reloaded', servedVersion };
  return { kind: 'offer-reload', servedVersion };
}

/**
 * Reads the build the server serves now from SvelteKit's `version.json`, or `null` when it cannot.
 *
 * `no-store` because the answer is only worth anything if it is the server's CURRENT one.
 */
export async function readServedVersion(
  fetchFn: typeof fetch,
  versionUrl: string
): Promise<string | null> {
  try {
    const res = await fetchFn(versionUrl, { cache: 'no-store' });
    if (!res.ok) {
      console.warn(
        `[staleBuild] ${versionUrl} answered ${res.status} - the served build is unknown`
      );
      return null;
    }
    const body: unknown = await res.json();
    const version =
      typeof body === 'object' && body !== null && 'version' in body
        ? (body as { version: unknown }).version
        : undefined;
    if (typeof version !== 'string' || version === '') {
      console.warn(`[staleBuild] ${versionUrl} carries no version - the served build is unknown`);
      return null;
    }
    return version;
  } catch (err) {
    console.warn(`[staleBuild] could not read ${versionUrl} - the served build is unknown:`, err);
    return null;
  }
}

/** What the recovery needs from the outside world - injected so a test drives every branch. */
export interface StaleBuildDeps {
  /** The build this tab booted on. */
  runningVersion: string;
  /** Where SvelteKit serves `version.json` for this deploy. */
  versionUrl: string;
  fetchFn: typeof fetch;
  /** The tab's `sessionStorage`, or `null` when it is denied (the guard then lives in memory). */
  storage: Storage | null;
  /** Asks the reader whether to reload now; resolves `true` if they accept. */
  confirmReload: () => Promise<boolean>;
  /** Reloads the document. */
  reload: () => void;
}

/** The recovery's single entry point, one per tab. */
export interface StaleBuildRecovery {
  /**
   * Handles one failed lazy load. Concurrent failures (a chunk and its dependencies fail together)
   * share the first one's decision, so the reader is asked once.
   */
  onPreloadError(error: unknown): Promise<StaleBuildVerdict>;
}

/** Builds the recovery over `deps`. */
export function createStaleBuildRecovery(deps: StaleBuildDeps): StaleBuildRecovery {
  // Mirrors the storage so a denied or failing `sessionStorage` still stops a loop within this page.
  let memoReloadedFor: string | null = null;
  // ONE decision in flight: every failure arriving while it runs is the same event seen twice.
  let inFlight: Promise<StaleBuildVerdict> | null = null;

  const readReloadedFor = (): string | null => {
    if (memoReloadedFor !== null) return memoReloadedFor;
    try {
      return deps.storage?.getItem(STALE_BUILD_RELOADED_FOR_KEY) ?? null;
    } catch (err) {
      console.warn('[staleBuild] sessionStorage unreadable, the reload guard is memory-only:', err);
      return null;
    }
  };

  const recordReloadedFor = (servedVersion: string): void => {
    memoReloadedFor = servedVersion;
    try {
      deps.storage?.setItem(STALE_BUILD_RELOADED_FOR_KEY, servedVersion);
    } catch (err) {
      console.warn('[staleBuild] sessionStorage unwritable, the reload guard is memory-only:', err);
    }
  };

  const decide = async (error: unknown): Promise<StaleBuildVerdict> => {
    const served = await readServedVersion(deps.fetchFn, deps.versionUrl);
    const verdict = judgeStaleBuild(deps.runningVersion, served, readReloadedFor());
    switch (verdict.kind) {
      case 'unknown':
        console.warn(
          `[staleBuild] a lazy module failed to load on build ${deps.runningVersion} and the served build is unknown - no reload offered:`,
          error
        );
        return verdict;
      case 'same-build':
        console.error(
          `[staleBuild] a lazy module failed to load on build ${deps.runningVersion}, which is still the served build - not a deploy, no reload offered:`,
          error
        );
        return verdict;
      case 'already-reloaded':
        console.error(
          `[staleBuild] this tab already reloaded toward build ${verdict.servedVersion} and still runs ${deps.runningVersion} - not offering the same reload again:`,
          error
        );
        return verdict;
      case 'offer-reload': {
        console.warn(
          `[staleBuild] build ${deps.runningVersion} is no longer served (now ${verdict.servedVersion}) - offering a reload:`,
          error
        );
        const accepted = await deps.confirmReload();
        if (!accepted) {
          console.log(
            '[staleBuild] the reader declined the reload; the tab stays on the old build'
          );
          return verdict;
        }
        recordReloadedFor(verdict.servedVersion);
        deps.reload();
        return verdict;
      }
    }
  };

  return {
    onPreloadError(error: unknown): Promise<StaleBuildVerdict> {
      if (inFlight) {
        console.log(
          '[staleBuild] another lazy load failed while one is being handled - same decision'
        );
        return inFlight;
      }
      inFlight = decide(error).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
