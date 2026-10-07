/**
 * The identity a frontend build gives itself, read back.
 *
 * `frontend/svelte.config.js` names every build `<builtAtMs>-<sha>` (`kit.version.name`), and
 * SvelteKit writes that string verbatim into `/_app/version.json`. The commit is therefore READ off
 * the bundle that is running, never inferred from a clock and a git history - an inference that
 * moved whenever a commit landed carrying an earlier date than the build before it. The timestamp
 * stays because it is what tells two builds of the SAME commit apart.
 *
 * Its own module, free of side effects, so `apkbuild.mjs` and `results.mjs` share ONE parser.
 */

/**
 * @param {unknown} version the `version` field of `/_app/version.json`
 * @param {string} where what was read, for the error
 * @returns {{ builtAt: string, commit: string }} the build instant (ISO) and the commit it was built from
 */
export function parseBuildStamp(version, where) {
  const match = /^(\d+)-([0-9a-f]{7,40})$/.exec(String(version));
  if (!match) {
    throw new Error(
      `${where} carries no build stamp of the form <builtAtMs>-<sha>: ${String(version).slice(0, 40)} - ` +
        'a bundle built before the build named its own commit cannot be attributed'
    );
  }
  return { builtAt: new Date(Number(match[1])).toISOString(), commit: match[2] };
}
