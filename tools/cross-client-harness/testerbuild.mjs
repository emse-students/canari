/**
 * WHETHER THE APP A PHONE GOT FROM THE PLAY TESTER PROGRAMME IS THE PRE-RELEASE IT CLAIMS TO BE, AND
 * BUILT FOR DEV - the provenance `apkbuild.mjs` records for an APK this rig built, for one it did not.
 *
 * WHY IT EXISTS (coordinator, 2026-10-27). A Play-signed build cannot be replaced by the rig's own
 * APK (the signatures differ, and an uninstall is never taken), so a phone moved onto the tester
 * build stays on it - and `pin.mjs` refuses an app whose bundle no record vouches for
 * (`appBundleVerdict`: `unrecorded`). The tester build's provenance is not on this machine: it is in
 * the release that shipped it. This module reads it there and writes the same record a rig build
 * writes, with `source: 'play-tester'`, so every reader of `a1-builds.ndjson` keeps one join.
 *
 * WHAT IT REQUIRES, every fact read, none inferred:
 *
 * - **A pre-release.** The tag carries a hyphen and the release is marked a pre-release - the one
 *   definition `release_kind()` uses. A STABLE is a production build (`android.yml` refuses a stable
 *   pointing anywhere else), and production is refused here before anything else is read.
 * - **Its Android job succeeded, and SAID it built for dev.** `android.yml` refuses a pre-release
 *   whose backend is not dev, then prints `Android build targets dev (...)`. That line in the job's
 *   own log is the bundle check a rig build does by grepping its bundle - which a release APK cannot
 *   give, since Tauri embeds the bundle compressed in the native library.
 * - **The phone runs THAT job's bundle.** The app's `/_app/version.json` names `<builtAtMs>-<sha>`:
 *   the commit must be the one the job checked out (`HEAD is now at <sha> chore: bump version to
 *   <version>`), and the build instant must fall inside the job's own window. A build of the same
 *   commit by any other job falls outside it.
 * - **The installed versionName AND versionCode are the tag's** (`dumpsys package`), as
 *   `scripts/bump-app-version.sh` writes them: the versionName is the NUMERIC CORE (`1.5.1`, Tauri
 *   copies `tauri.conf.json`'s version, which never carries the suffix), so it cannot tell two alphas
 *   of one version apart - the versionCode band does (`(major*1e6 + minor*1e3 + patch)*100 + N`).
 *
 * Pure: no rig, no phone, no network - `a1tester.mjs` gathers the facts and this decides.
 */

/**
 * What the stores know a pre-release tag as, by `scripts/bump-app-version.sh`'s own rule: the full
 * `version` (what the bump commit names), the numeric `core` (Android's versionName) and the
 * versionCode band `(major*1e6 + minor*1e3 + patch)*100 + N`. Null for anything but `vX.Y.Z-alpha.N`
 * with N in 1..98 - a stable included, whose rank 99 is a production build.
 *
 * @param {string} tag
 * @returns {{version: string, core: string, code: number} | null}
 */
export function storeIdentity(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/.exec(String(tag));
  if (!m) return null;
  const [major, minor, patch, rank] = m.slice(1).map(Number);
  if (rank < 1 || rank > 98 || minor > 999 || patch > 999) return null;
  return {
    version: `${major}.${minor}.${patch}-alpha.${rank}`,
    core: `${major}.${minor}.${patch}`,
    code: (major * 1_000_000 + minor * 1_000 + patch) * 100 + rank,
  };
}

/** The line `android.yml` prints once its pre-release check let a dev build through. */
export const TARGETS_DEV = /^Android build targets dev \(/;

/** The job of the release run that builds the Android artefacts (`release.yml` -> `android.yml`). */
export const ANDROID_JOB = /Build Android APK$/;

/**
 * The commit the Android job built, from its own checkout line, or null.
 *
 * @param {string} log the job's log, one line per entry (the GitHub prefix columns are tolerated)
 * @param {string} version the version the release wrote across the project (`1.5.1-alpha.1`)
 */
export function builtCommitOf(log, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`HEAD is now at ([0-9a-f]{7,40}) chore: bump version to ${esc}$`);
  for (const line of String(log).split('\n')) {
    const m = re.exec(line.trimEnd());
    if (m) return m[1];
  }
  return null;
}

/** Whether the job's log carries `android.yml`'s dev line (the timestamp column is skipped). */
export function saidDev(log) {
  return String(log)
    .split('\n')
    .some((line) => TARGETS_DEV.test(line.replace(/^.*?\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '').trimEnd()));
}

/**
 * The verdict, and on acceptance the record to append to `a1-builds.ndjson`.
 *
 * @param {object} f
 * @param {string} f.tag the release tag (`v1.5.1-alpha.1`)
 * @param {{isPrerelease: boolean} | null} f.release the GitHub release of that tag
 * @param {{id: number, run: number, name: string, conclusion: string, startedAt: string, completedAt: string} | null} f.job
 * @param {string} f.log the Android job's log
 * @param {{builtAt: string, commit: string}} f.stamp the running app's `/_app/version.json`, parsed
 * @param {{versionName: string|null, versionCode: string|null}} f.installed from `dumpsys package`
 * @param {string} f.site the estate the rig reports on - the record's origin when accepted
 * @param {string} [f.now] ISO instant of the recording
 * @returns {{ok: boolean, reason: string, record?: object}}
 */
export function testerBuildVerdict({ tag, release, job, log, stamp, installed, site, now = new Date().toISOString() }) {
  const ids = storeIdentity(tag);
  if (!ids) return { ok: false, reason: `${tag} is not a pre-release tag - a stable is a production build` };
  const { version, core, code } = ids;
  if (release?.isPrerelease !== true) return { ok: false, reason: `the release ${tag} is not marked a pre-release` };
  if (!String(site).startsWith('https://dev.')) return { ok: false, reason: `the rig reports on ${site}, and a tester build serves dev only` };
  if (!job || !ANDROID_JOB.test(job.name)) return { ok: false, reason: `no Android build job in the release run of ${tag}` };
  if (job.conclusion !== 'success') return { ok: false, reason: `the Android job of ${tag} ended ${job.conclusion}` };
  if (!saidDev(log)) return { ok: false, reason: `the Android job of ${tag} never said it built for dev` };
  const built = builtCommitOf(log, version);
  if (!built) return { ok: false, reason: `the Android job of ${tag} names no checkout of its version bump` };
  const sha = String(stamp?.commit ?? '');
  if (sha.length < 7 || !(built.startsWith(sha) || sha.startsWith(built))) {
    return { ok: false, reason: `the phone runs ${sha.slice(0, 9) || '(no stamp)'}, the job built ${built.slice(0, 9)}` };
  }
  const at = Date.parse(stamp.builtAt);
  if (!(at >= Date.parse(job.startedAt) && at <= Date.parse(job.completedAt))) {
    return { ok: false, reason: `the phone's bundle was built at ${stamp.builtAt}, outside the job (${job.startedAt} - ${job.completedAt})` };
  }
  if (installed?.versionName !== core) {
    return { ok: false, reason: `the phone has versionName ${installed?.versionName ?? '(none)'}, the tag's is ${core}` };
  }
  if (String(installed?.versionCode ?? '') !== String(code)) {
    return { ok: false, reason: `the phone has versionCode ${installed?.versionCode ?? '(none)'}, ${tag}'s band is ${code} - another rank of ${core}` };
  }
  return {
    ok: true,
    reason: 'ok',
    record: {
      builtAt: stamp.builtAt,
      head: built.slice(0, 9),
      dirty: false,
      diffSha: null,
      recordedAt: now,
      origin: site,
      estate: 'dev',
      ref: tag,
      // THE BUNDLE CHECK IS THE JOB'S: `android.yml` refused anything but dev and said so.
      bundleOk: true,
      source: 'play-tester',
      versionName: installed.versionName,
      versionCode: installed.versionCode ?? null,
      run: job.run,
      job: job.id,
    },
  };
}
