/**
 * The argument grammar of `seed-bench.mjs`, kept pure so `archive/seedargs-selftest.mjs` can hold it.
 *
 * WHY A SEPARATE FILE. `seed-bench.mjs` opens browsers and writes to the estate the moment it is
 * imported, so a test of its parsing would have to run the seeding too. The grammar is the part a
 * typo reaches first - `--post 40` for `--posts 40` used to be the classic way to seed nothing and
 * report success - so it refuses anything it does not know rather than ignoring it.
 */

/** The four things the seeder can owe, in the order it builds them. */
export const SEED_PARTS = ['posts', 'video', 'events', 'salon'];

/** What a run targets when nothing is said: enough to scroll `/posts`, a week of agenda, a long salon. */
export const SEED_DEFAULTS = { posts: 40, events: 6, messages: 100 };

const COUNT_FLAGS = { '--posts': 'posts', '--events': 'events', '--messages': 'messages' };

/**
 * Parses `argv` (without the runtime and script) into `{ dry, only, posts, events, messages }`.
 *
 * Every count is a TARGET, not an increment: the seeder tops the estate up to it, which is what
 * makes a second run a no-op. A count must be a positive integer, because zero would read as
 * "seed nothing" while the part still ran its reads, and a fraction has no meaning here.
 *
 * @throws Error naming the offending argument - never a silent default.
 */
export function parseSeedArgs(argv) {
  const out = { dry: false, only: [...SEED_PARTS], ...SEED_DEFAULTS };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error(`${arg} given twice`);
    seen.add(arg);
    if (arg === '--dry') {
      out.dry = true;
    } else if (arg === '--only') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--only needs a comma-separated list');
      const parts = value.split(',').map((p) => p.trim());
      const unknown = parts.filter((p) => !SEED_PARTS.includes(p));
      if (unknown.length) {
        throw new Error(
          `--only: unknown part(s) ${unknown.join(', ')} - known: ${SEED_PARTS.join(', ')}`
        );
      }
      out.only = SEED_PARTS.filter((p) => parts.includes(p));
    } else if (arg in COUNT_FLAGS) {
      const raw = argv[++i];
      if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
        throw new Error(
          `${arg} needs a positive integer, got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}`
        );
      }
      out[COUNT_FLAGS[arg]] = Number(raw);
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)} - known: --dry --only --posts --events --messages`
      );
    }
  }
  return out;
}
