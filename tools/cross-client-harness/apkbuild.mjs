#!/usr/bin/env node
/**
 * WHETHER THE APK ON THE PHONE IS ANY COMMIT AT ALL - the provenance a build stamp cannot carry.
 *
 *   bun apkbuild.mjs            # what is recorded for every APK this rig has built
 *
 * **THE HOLE THIS CLOSES, AND IT SILENTLY AFFECTED EVERY ROW MEASURED DURING A FIX.** A device
 * verdict is dated by `a1Build`, and that commit is the one the bundle NAMES (`<builtAtMs>-<sha>`, the
 * HEAD the build ran under). That is exact for a build made from a clean tree and WRONG for every other kind, because `a1apk.mjs`
 * builds from the WORKING TREE - which is the whole point of it, and the normal shape of a session:
 * write a fix, build, measure, commit.
 *
 * So the ledger said NOTIF-16 passed on `1fd7cecd7` (2026-09-08), and `1fd7cecd7` is the commit
 * BEFORE the fix that makes it pass. Nothing was wrong with the measurement; the phone really did
 * file a mention on `canari_mentions`. What was wrong is the sentence a later reader gets: *this
 * verdict was taken on that code*. It was not, and re-running that commit would have failed.
 *
 * **IT RECORDS; `a1apk.mjs` REFUSES ONLY AN UNDECLARED DIRTY APP TREE.** Building from a dirty tree
 * is how a fix gets measured before it is committed, so `--dirty` keeps that loop open. Since
 * 2026-10-26 (coordinator), an uncommitted change that can reach the APK (`appTreeDirt` in
 * `a1plan.mjs`: anything but `tools/` and the docs) is refused unless `--dirty` declares it. What must
 * not happen is a verdict that CLAIMS a commit it was not built from. So the tree state is measured
 * BEFORE the build (`treeState`) and written down keyed by the one value the phone can later be
 * asked for, with the dirty paths beside the hash.
 *
 * **THE KEY IS `builtAt`, BECAUSE IT IS THE ONLY THING BOTH ENDS KNOW.** The preflight reads
 * `/_app/version.json` off the running app and gets a millisecond timestamp; this module reads the
 * SAME file out of the bundle that was just packaged, before it is installed. Nothing else is shared:
 * the commit is a derivation on both sides, so joining on it would join two guesses.
 *
 * **AND THE DIFF IS HASHED RATHER THAN STORED.** A verdict needs to know that the code was not the
 * commit and to be able to tell one dirty build from another; it does not need the diff, and this
 * repository is public while a working tree is not.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STATE_DIR } from './names.mjs';
import { parseBuildStamp } from './buildstamp.mjs';
import { porcelainPaths } from './a1plan.mjs';

const HARNESS = dirname(fileURLToPath(import.meta.url));
const REPO = join(HARNESS, '..', '..');

/** Outside the repository with the rest of the machine-local state - it names a local tree. */
const FILE = join(STATE_DIR, 'a1-builds.ndjson');

/**
 * The version stamp of the bundle Tauri just packaged.
 *
 * THE STATIC PATH, and only it. `frontend/build` holds the adapter-STATIC shape after an APK build
 * and the adapter-NODE shape (`build/client/_app/...`) after `make local-frontend`, and the two are
 * different artefacts. Reading whichever happens to exist would silently record the estate's stamp
 * against the phone's APK the first time the order of those two commands changed.
 */
function packagedStamp(repo = REPO) {
  const at = join(repo, 'frontend', 'build', '_app', 'version.json');
  if (!existsSync(at)) {
    throw new Error(
      `no ${at} - frontend/build does not hold the adapter-static shape, so this is not the bundle ` +
        'an APK was just built from'
    );
  }
  const parsed = JSON.parse(readFileSync(at, 'utf8'));
  return parseBuildStamp(parsed.version, at).builtAt;
}

/** `git` output as text, trimmed - a throw here is a repository that cannot be read. */
const gitIn = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

/**
 * THE TREE AS IT IS NOW: its HEAD, whether anything is uncommitted, a hash of that, and the paths.
 *
 * MEASURED BEFORE THE BUILD, never after it (2026-10-26). `tauri android build` regenerates
 * `frontend/src-tauri/gen/android/app/src/main/AndroidManifest.xml` from the deep-link config, so a
 * tree read AFTER the build was "dirty" on every build. Both alpha.5 A1 builds, made from fresh
 * detached worktrees of two different commits, recorded the same diff `209727a40d43`, which was
 * exactly that regenerated manifest. The source a build compiles is the tree BEFORE it.
 *
 * @param {string} [repo]
 * @returns {{head: string, dirty: boolean, diffSha: string|null, dirtyFiles: string[]}}
 */
export function treeState(repo = REPO) {
  const git = (...args) => gitIn(repo, ...args);
  // The commit is recorded as the tree's HEAD rather than resolved from the timestamp: at build
  // time HEAD is a FACT, where the timestamp derivation is what this module exists to qualify.
  const head = git('rev-parse', '--short', 'HEAD');
  // `--porcelain` covers staged, unstaged and untracked in one answer. UNTRACKED FILES COUNT: a new
  // module the build imports is exactly the case where the commit understates the code most.
  const porcelain = git('status', '--porcelain');
  const dirty = porcelain.length > 0;
  // HEAD's own diff plus the untracked list - `git diff HEAD` does not mention untracked files, so
  // the porcelain lines are folded in or two builds differing only by a new file would hash alike.
  const diffSha = dirty ? createHash('sha256').update(git('diff', 'HEAD')).update(porcelain).digest('hex').slice(0, 12) : null;
  return { head, dirty, diffSha, dirtyFiles: porcelainPaths(porcelain) };
}

/**
 * Write down what the tree looked like when this APK was built.
 *
 * Called by `a1apk.mjs` after the build and BEFORE the install: the record has to exist by the time
 * anything asks the phone what it is running.
 *
 * @param {string} [repo] the tree the APK was built from - this checkout, or a `--ref` worktree
 * @returns the record, so the caller can print it rather than re-deriving it
 */
export function recordApkBuild(repo = REPO, artefact = {}, state = treeState(repo)) {
  const builtAt = packagedStamp(repo);
  const { head, dirty, diffSha, dirtyFiles } = state;
  // `artefact`: the APK's sha256, the origin it was planned for and its bundle verdict, which
  // `installVerdict` in `a1plan.mjs` requires before a `--no-build` install (R2 review).
  const record = { builtAt, head, dirty, diffSha, ...(dirty ? { dirtyFiles } : {}), recordedAt: new Date().toISOString(), ...artefact };
  appendFileSync(FILE, `${JSON.stringify(record)}\n`);
  return record;
}

/**
 * Writes down a build this rig did NOT make: a Play tester build whose provenance `testerbuild.mjs`
 * read from its release and accepted (`a1tester.mjs`). Same file, same `builtAt` key, so every
 * reader keeps one join; `source: 'play-tester'` says where the facts came from.
 *
 * @param {object} record the record `testerBuildVerdict` returned
 */
export function recordTesterBuild(record) {
  if (record?.source !== 'play-tester' || !record.builtAt) throw new Error('recordTesterBuild: not a tester build record');
  appendFileSync(FILE, `${JSON.stringify(record)}\n`);
  return record;
}

/** Every recorded build, oldest first; a truncated line is skipped, never fatal. */
export function apkBuilds() {
  if (!existsSync(FILE)) return [];
  const out = [];
  for (const line of readFileSync(FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      console.log(`[apkbuild] skipped an unparseable record: ${line.slice(0, 80)}`);
    }
  }
  return out;
}

/**
 * What is known about the APK whose bundle carries `builtAt`, or null when nothing is.
 *
 * NULL IS "NOT RECORDED", NEVER "CLEAN". Every APK built before this module existed answers null,
 * and so does one built by CI or by hand, so a reader that treated null as clean would state the
 * exact falsehood this module was written to remove.
 *
 * @param {string} builtAt the ISO stamp the preflight read off the running app
 */
export function apkBuildProvenance(builtAt) {
  if (!existsSync(FILE)) return null;
  let found = null;
  for (const line of readFileSync(FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      // The LAST match wins: one bundle can be packaged and installed twice, and the later record
      // is the one that describes the APK now on the phone.
      if (row.builtAt === builtAt) found = row;
    } catch {
      // A truncated final line is an interrupted write, not a reason to lose the rest of the file.
      continue;
    }
  }
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Printed newest-first: the question is almost always "what is on the phone right now".
  const rows = existsSync(FILE)
    ? readFileSync(FILE, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
        .reverse()
    : [];
  console.log(`[apkbuild] ${rows.length} APK build(s) recorded by this rig`);
  for (const r of rows) {
    console.log(
      `  ${r.builtAt}  ${r.head}  ${r.dirty ? `DIRTY (diff ${r.diffSha}) - this build is NOT that commit` : 'clean - the commit describes it'}`
    );
  }
  if (rows.length === 0) {
    console.log('  nothing yet - a build recorded here appears after the next `bun a1apk.mjs`');
  }
}
