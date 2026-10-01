/**
 * THE SET OF PATHS THE APPLICATION OWNS, READ FROM THE TREE, AND THE 404 RULE THAT FOLLOWS FROM IT.
 *
 * `srvlog.mjs` used to forgive scanner 404s by enumerating spellings (`/wp-*`, `/administrator/`),
 * so every new scanner spelling (`/WP`, `/old`) landed in `unexplained` and stopped a `--repeat`.
 * The fact that closes the class is knowable without a build: a SvelteKit route is a directory
 * under `frontend/src/routes/` holding a `+page*` or `+server*` file, and static files are the
 * entries of `frontend/static/`. A 404 on a path inside that set is a defect; a 404 outside it
 * provably cannot be ours.
 *
 * CONSERVATIVE BY CONSTRUCTION: a path counts as owned when it STARTS WITH any route or static
 * entry (so `/chat/zzz` is still ours to explain), and `/api/`, `/.well-known/` and `/_app/` are
 * always owned - other services and the build answer there. Only a path matching none of that is
 * foreign, and foreign 404s are REPORTED (notable) and never gate.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..', '..', 'frontend');

/** Namespaces answered by other services or by the build, never forgiven here. */
const ALWAYS_OWNED = ['api', '.well-known', '_app'];

/** A route directory owns its path when it holds one of these. */
const ROUTE_FILE = /^\+(page|server)[.\w-]*$/;

/**
 * One route directory name as a matcher of a request segment, or `null` for a group `(x)` that adds
 * no segment. `[...rest]` and `[[opt]]` are handled by the caller's prefix rule: matching a prefix of
 * the path already covers them.
 */
function segmentMatcher(name) {
  if (/^\(.+\)$/.test(name)) return null;
  if (/^\[\[?\.{0,3}[\w]+\]?\]$/.test(name)) return () => true;
  return (seg) => seg === name;
}

/** Every route directory under `root` as a list of segment matchers. */
function walkRoutes(root, matchers = [], out = []) {
  const entries = readdirSync(root, { withFileTypes: true });
  if (matchers.length && entries.some((e) => e.isFile() && ROUTE_FILE.test(e.name))) out.push(matchers);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = segmentMatcher(e.name);
    walkRoutes(join(root, e.name), m ? [...matchers, m] : matchers, out);
  }
  // A route FILE directly in a directory named like a file (`robots.txt/+server.ts`) is a directory
  // here, so it is covered by the walk above; nothing else to add.
  return out;
}

/**
 * Build the ownership predicate from a routes directory and a static directory.
 *
 * @param {{routesDir?: string, staticDir?: string}} [dirs] injectable so a selftest can use fixtures
 * @returns {(path: string) => boolean} whether the application can own `path`
 */
export function makeOwnedPaths({
  routesDir = join(FRONTEND, 'src', 'routes'),
  staticDir = join(FRONTEND, 'static'),
} = {}) {
  const routes = existsSync(routesDir) ? walkRoutes(routesDir) : [];
  if (!routes.length) throw new Error(`ownedpaths: no route found under ${routesDir} - refusing to forgive anything`);
  const staticNames = existsSync(staticDir) ? readdirSync(staticDir) : [];
  return (path) => {
    const segs = path.split('?')[0].split('#')[0].split('/').filter(Boolean);
    if (!segs.length) return true; // the root document
    if (ALWAYS_OWNED.includes(segs[0])) return true;
    if (staticNames.includes(segs[0])) return true;
    return routes.some((ms) => ms.length <= segs.length && ms.every((m, i) => m(segs[i])));
  };
}

/** `[404] GET /path` as `frontend-ssr` writes it. */
const FOUR_OH_FOUR = /^\[404\] (?:GET|HEAD) (\S+)$/;

/**
 * Whether `line` is a 404 on a path this application cannot own - a scanner's guess.
 *
 * @param {string} line one log line
 * @param {(path: string) => boolean} isOwned from `makeOwnedPaths`
 */
export function isForeign404(line, isOwned) {
  const m = FOUR_OH_FOUR.exec(line);
  return m !== null && !isOwned(m[1]);
}

let cached = null;
/** The predicate over the real tree, built once per process. */
export const ownedPaths = () => (cached ??= makeOwnedPaths());
