/**
 * WHICH ESTATE A QUERY IS ABOUT, DERIVED FROM THE ONE CONSTANT THAT DECIDES WHERE THE CAMPAIGN RUNS.
 *
 * THE INSTRUMENT WAS POINTED AT A DIFFERENT ESTATE THAN THE DEVICE, and it answered confidently.
 * `psql` and `redis` reached production unconditionally, so on 2026-09-04 - the first local run of
 * HEAL-NEW-0 - `newdevice.mjs` reported "the server knows 573 enrolled device(s)" (production's
 * count), "the account spends 0/15 device slot(s)" (an account production has never seen) and then
 * `registered=false, addressable=false` about a device whose `key_package` row had been written to
 * the LOCAL database eighty seconds earlier. The row failed. Nothing in the output said which
 * database had been asked, which is the campaign's own worst failure mode: an instrument answering
 * about itself while reading as an answer about the application.
 *
 * So the target follows `SITE`, exactly as `APP_TAB` does. There is no flag and no fallback: a rig
 * pointed at the local estate asks the local containers, one pointed at production asks production
 * through the tunnel, and neither can be half-configured.
 *
 * **AND THAT IS WHY THIS IS ITS OWN MODULE RATHER THAN TWO MORE EXPORTS IN `ssh.mjs`.** Reading
 * `SITE` means importing `names.mjs`, which is gitignored - it holds real display names and this
 * repository is PUBLIC - so a module that imports it cannot be imported on a fresh checkout at all.
 * Putting these two functions in `ssh.mjs` made `srvlog.mjs` and `devices.mjs` unimportable in CI,
 * and `gate-selftest.mjs` caught it the same hour: two of the eleven gated self-tests reach those
 * modules for pure functions and died with `ERR_MODULE_NOT_FOUND`. **A transport is machine-agnostic
 * and an ESTATE is not**, so they are different modules - the same split `native-residue.mjs`,
 * `servable.mjs`, `usability.mjs` and `marker.mjs` each exist for.
 */
import { execFileSync } from 'node:child_process';
import { SITE } from './names.mjs';
import { ssh } from './ssh.mjs';

/**
 * Whether the campaign's target is on this machine. One read, at import, no flag.
 *
 * EXPORTED because "which estate" decides more than which container to talk to. `results.mjs` needs
 * it to know which git history contains the bundle a client is running: a deployment is built by CD
 * from a commit on `origin/main`, and the local estate is built by `make local-frontend` from the
 * WORKING TREE. Same question, same answer, one place.
 */
export const LOCAL =
  new URL(SITE).hostname === 'localhost' || new URL(SITE).hostname === '127.0.0.1';

/**
 * Runs a command in a container of whichever estate `SITE` names.
 *
 * The local containers are on THIS machine, so there is no host to reach and no tunnel to cross -
 * `docker` is run directly. The compose project prefixes the names (`canari-local-*`), which is also
 * the only thing that distinguishes the estates on a box that carries several: production's are
 * `infrastructure-*`, dev's are `canari-dev-*`, and reading the name before writing is the rule
 * `databases.md` states for exactly this reason.
 */
const inContainer = (localName, prodName, command, opts) =>
  LOCAL
    ? execFileSync('docker', ['exec', localName, 'sh', '-lc', command], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        ...opts,
      }).trim()
    : ssh('canari', `docker exec ${prodName} ${command}`, opts);

/** `redis-cli <args...>` inside the estate's Redis container. Arguments are already quoted by the caller. */
export const redis = (args, opts) =>
  inContainer('canari-local-redis-1', 'infrastructure-redis-1', `redis-cli ${args}`, opts);

/**
 * Runs `sql` on the estate's database, tuples-only and unaligned. Read-only by convention.
 *
 * THE ROLE DIFFERS BETWEEN THE TWO, and it is not a detail. Production's dump assigns ownership to
 * `canari`, and restoring it locally recreates that role WITHOUT LOGIN - so a local `psql -U canari`
 * answers `FATAL: role "canari" is not permitted to log in`, which reads exactly like a permissions
 * problem with the query. The local superuser is `admin`, declared in
 * `infrastructure/local/docker-compose.yml`.
 */
export const psql = (sql, opts) =>
  inContainer(
    'canari-local-postgres-1',
    'infrastructure-postgres-1',
    `psql -U ${LOCAL ? 'admin' : 'canari'} -d auth_db -tAc "${sql.replace(/"/g, '\\"')}"`,
    { timeoutMs: 60_000, ...opts }
  );

/** Chrome and Nest colour their output; a rule matching a bare word must not meet an escape. */
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * One service's log lines in the window, from WHICHEVER ESTATE `SITE` NAMES - ANSI stripped, blanks
 * dropped.
 *
 * ## The defect this moved here to end
 *
 * THE THIRD OBSERVER NEVER FOLLOWED THE CAMPAIGN OFF PRODUCTION. `psql` and `redis` were made to
 * follow `SITE` when the rig moved to the local estate on 2026-09-03; this reader was left spelling
 * `ssh canari docker logs infrastructure-<service>-1`, so it answered about PRODUCTION for every
 * local run - and answered CONFIDENTLY, because production is busy and a window is never empty.
 *
 * It cost a verdict the same day it was noticed. COMM-14 asks whether the three channel notification
 * levels are enforced, and reads `[CHANNEL_PUSH] channel=<id> ... recipients=N` as the decision
 * itself. On 2026-09-05 the row recorded **FAIL** on `mentionsDelivers` and `allDelivers` while the
 * PHONE's tray held both notifications: the local container had logged thirty such lines and the
 * instrument had read production's, where this run's channel id has never existed. An absence in the
 * wrong estate is indistinguishable from a decision not taken.
 *
 * `2>&1` because Nest logs to stdout and tracing to stderr, and a check reading only one of them
 * would be blind to half the platform.
 *
 * @param {string} service the compose service name, e.g. `social-service`
 * @param {string} since a docker `--since` value: an ISO instant, or `900s`
 * @returns {string[]} the window's lines, trimmed, in order
 */
export function srvLines(service, since) {
  const out = LOCAL
    ? execFileSync(
        'docker',
        ['logs', '--since', since, `canari-local-${service}-1`],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    : ssh('canari', `docker logs --since ${since} infrastructure-${service}-1 2>&1 || true`, {
        timeoutMs: 90_000,
      });
  return out
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
