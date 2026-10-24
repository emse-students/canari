/**
 * WHICH ESTATES THIS RIG MAY ADDRESS - THE LOCAL ONE AND DEV - AND THE REFUSAL OF EVERY OTHER, PRODUCTION FIRST.
 *
 * ## The defect this module ends (R1 of the 1.4.1 campaign, 2026-10-24)
 *
 * `estate.mjs` knew two estates and decided between them with ONE boolean: `LOCAL`, true for
 * `localhost`, and FALSE FOR EVERYTHING ELSE - and "everything else" was routed to PRODUCTION's
 * containers. Pointing `SITE` at `https://dev.canari-emse.fr`, which is exactly what the 1.4.1
 * campaign needs, would therefore have sent every `psql`, every `redis` and every server-log read of
 * fourteen rig files to production's tables and production's logs, and reported them as dev's.
 * Nothing in the output would have said so - the campaign's own worst failure mode, an instrument
 * answering about the wrong estate while reading as an answer about the application. And the first
 * query that later learned to WRITE would have written there.
 *
 * ## What replaces it: an ALLOWLIST, and production is not a value
 *
 * An estate is `local` or `dev`. Any other `SITE` - production under either of its names, a typo, a
 * staging host nobody declared - is REFUSED with an `EstateRefusedError`, and there is no branch in
 * this rig that knows how to reach production's containers at all: the code that did is deleted,
 * not disabled. A destructive control needs an allowlist of what it may touch (`CLAUDE.md`), and a
 * rig that reads is one `UPDATE` away from being one.
 *
 * Dev's containers are found the way `infrastructure/dev/reset-dev-to-seed.sh` finds them: by the
 * compose LABEL `com.docker.compose.project=canari-dev`, `status=running`, EXACTLY ONE per service,
 * and the label re-read on the container before it is used. No container NAME is spelt, so no name
 * can be wrong in the direction that matters.
 *
 * ## Why it is pure
 *
 * `estate.mjs` imports `names.mjs`, which is gitignored (display names; this repository is PUBLIC),
 * so nothing that imports it can run in CI. The routing - which estate, which command, which host -
 * is therefore built HERE by `makeEstate`, from injected transports, and `archive/estate-selftest.mjs`
 * drives it with stubs: production refused before any transport is touched, dev addressed by label
 * and never by a production name. `estate.mjs` is the one place the real transports are plugged in.
 */

/** The dev estate's public origin. Its host is the only non-local host the rig accepts. */
export const DEV_SITE = 'https://dev.canari-emse.fr';

/** The compose project dev is deployed as (`name:` in `infrastructure/docker-compose.dev.yml`). */
export const DEV_PROJECT = 'canari-dev';

/** Dev's database. `auth_db` is the only one, as on every estate. */
export const DEV_DATABASE = 'auth_db';

/** The hostnames that ARE this machine. A local estate is reached with `docker` directly. */
export const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/**
 * The hosts that serve PRODUCTION's application. Used for one thing only: to name a refusal
 * precisely and to refuse a browser tab already sitting on production (`refuseProductionPage`). The
 * decision about `SITE` never consults it - that one is the allowlist above - so a production name
 * missing from this list could cost a sentence, never a read.
 */
export const PRODUCTION_APP_HOSTS = ['canari-emse.fr', 'www.canari-emse.fr', 'canari.emse.fr'];

/** The page origins of the Tauri apps: an engine scheme, not an estate (`names.example.mjs` `ORIGIN`). */
export const TAURI_ORIGINS = ['http://tauri.localhost', 'tauri://localhost'];

/** Remote exit status of a dev command the rig itself refused (container missing, ambiguous, mislabelled). */
export const REFUSED_STATUS = 97;

/**
 * Thrown when the rig is asked to address an estate it does not accept. TYPED, so a caller can tell
 * this refusal from a transport failure without reading its message.
 */
export class EstateRefusedError extends Error {
  /**
   * @param {string} site the value that was refused
   * @param {'production' | 'unknown' | 'unparseable' | 'insecure-dev' | 'no-dev-host'} reason
   * @param {string} message
   */
  constructor(site, reason, message) {
    super(message);
    this.name = 'EstateRefusedError';
    this.site = site;
    this.reason = reason;
  }
}

const ACCEPTED = `the local estate (http://localhost:<port>) or dev (${DEV_SITE})`;

/**
 * The estate a `SITE` names: `'local'` or `'dev'`, or an `EstateRefusedError`.
 *
 * Dev is accepted ONLY as `https://` on the default port: the rig's whole reasoning about dev (the
 * Tauri scope, the CSP, the edge) is about that origin, and a `http://dev...` or `:8443` would be
 * another origin wearing its name.
 *
 * @param {string} site
 * @returns {'local' | 'dev'}
 */
export function estateOf(site) {
  let url;
  try {
    url = new URL(site);
  } catch {
    throw new EstateRefusedError(site, 'unparseable', `REFUSED: SITE '${site}' is not a URL. This rig addresses ${ACCEPTED}.`);
  }
  if (LOCAL_HOSTS.includes(url.hostname)) return 'local';
  if (url.hostname === new URL(DEV_SITE).hostname) {
    if (url.protocol === 'https:' && url.port === '') return 'dev';
    throw new EstateRefusedError(
      site,
      'insecure-dev',
      `REFUSED: SITE '${site}' names dev's host on another origin. Dev is exactly ${DEV_SITE}.`,
    );
  }
  if (PRODUCTION_APP_HOSTS.includes(url.hostname)) {
    throw new EstateRefusedError(
      site,
      'production',
      `REFUSED: SITE '${site}' is PRODUCTION. This rig addresses ${ACCEPTED} and nothing else - ` +
        'production is not a value it accepts, for reads as much as writes. Point SITE in names.mjs at dev.',
    );
  }
  throw new EstateRefusedError(site, 'unknown', `REFUSED: SITE '${site}' is no estate this rig knows. It addresses ${ACCEPTED}.`);
}

/**
 * `origins` (the `ORIGIN` map of `names.mjs`) unchanged, or a throw when a WEB origin names another
 * estate than `estate`: a device pointed at production while `SITE` says dev is production driven
 * under dev's name. A Tauri engine scheme is not an estate and passes.
 *
 * @param {Record<string, string>} origins
 * @param {'local' | 'dev'} estate
 */
export function refuseForeignOrigins(origins, estate) {
  for (const [device, origin] of Object.entries(origins)) {
    if (TAURI_ORIGINS.includes(origin)) continue;
    let other;
    try {
      other = estateOf(origin);
    } catch (e) {
      throw new EstateRefusedError(origin, e.reason ?? 'unknown', `REFUSED: ORIGIN.${device} - ${e.message}`);
    }
    if (other !== estate) {
      throw new EstateRefusedError(origin, 'unknown', `REFUSED: ORIGIN.${device} is ${origin} (${other}), not the ${estate} estate SITE names - fix names.mjs`);
    }
  }
  return origins;
}

/**
 * Throws when a browser page is open on PRODUCTION's application, whatever `SITE` says.
 *
 * `SITE` decides where the rig NAVIGATES, but a Chrome profile keeps the tab it last had - and a
 * profile that once ran a campaign on production may still be sitting there. Attaching to it and
 * typing would act on production with the campaign's accounts. So the page a runner attaches to is
 * checked too, by the host its URL carries. A page that is not http(s) (`about:blank`, the Tauri
 * schemes) is not an estate and passes.
 *
 * @param {string} pageUrl
 */
export function refuseProductionPage(pageUrl) {
  let host;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    host = url.hostname;
  } catch {
    return;
  }
  if (PRODUCTION_APP_HOSTS.includes(host)) {
    throw new EstateRefusedError(
      pageUrl,
      'production',
      `REFUSED: the page to attach to is on PRODUCTION (${pageUrl}). This rig never drives production - ` +
        'navigate that tab to the campaign estate or close it, then run again.',
    );
  }
}

/** Single-quotes a string for a POSIX shell: the one quoting in which nothing expands. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const SERVICE = /^[a-z0-9][a-z0-9-]*$/;
const SINCE = /^[0-9A-Za-z:.+-]+$/;

/**
 * The remote shell snippet that sets `$c` to the ONE running container of `service` in dev's
 * compose project, or exits `REFUSED_STATUS` saying why. The label is filtered on AND re-read from
 * the container, the shape `reset-dev-to-seed.sh`'s `container_for` + `require_dev` take.
 *
 * @param {string} service a compose service name, e.g. `postgres`
 */
export function devResolveContainer(service) {
  if (!SERVICE.test(service)) throw new Error(`devResolveContainer: '${service}' is not a compose service name`);
  const label = `com.docker.compose.project=${DEV_PROJECT}`;
  return (
    `c=$(docker ps --filter label=${label} --filter label=com.docker.compose.service=${service} ` +
    `--filter status=running --format '{{.Names}}'); ` +
    `n=$(printf '%s\\n' "$c" | grep -c .); ` +
    `if [ "$n" != 1 ]; then echo "[estate] refused: $n running '${service}' container(s) in project ${DEV_PROJECT}" >&2; exit ${REFUSED_STATUS}; fi; ` +
    `p=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$c"); ` +
    `if [ "$p" != ${DEV_PROJECT} ]; then echo "[estate] refused: $c reports project '$p', not ${DEV_PROJECT}" >&2; exit ${REFUSED_STATUS}; fi`
  );
}

/** `docker exec` of an already shell-quoted command line in dev's `service` container. */
export const devExecCommand = (service, commandLine) => `${devResolveContainer(service)}; docker exec "$c" ${commandLine}`;

/**
 * `psql` on dev's database, as the user the container was started with (read from its own
 * environment, as the reset script does), with the SQL single-quoted so a `$1` or a dollar quote in
 * it reaches Postgres intact rather than being expanded by the remote shell.
 */
export const devPsqlCommand = (sql) =>
  `${devResolveContainer('postgres')}; u=$(docker exec "$c" printenv POSTGRES_USER); ` +
  `if [ -z "$u" ]; then echo "[estate] refused: $c carries no POSTGRES_USER" >&2; exit ${REFUSED_STATUS}; fi; ` +
  `docker exec "$c" psql -X -U "$u" -d ${DEV_DATABASE} -tAc ${shq(sql)}`;

/** One dev service's log window, both streams. */
export function devLogsCommand(service, since) {
  if (!SINCE.test(since)) throw new Error(`devLogsCommand: '${since}' is not a docker --since value`);
  return `${devResolveContainer(service)}; docker logs --since ${since} "$c" 2>&1`;
}

/** Chrome and Nest colour their output; a rule matching a bare word must not meet an escape. */
// oxlint-disable-next-line no-control-regex -- ESC is the character this must match; that IS the rule.
const ANSI = /\u001b\[[0-9;]*m/g;

/** A raw log dump as the trimmed, non-blank, uncoloured lines a classifier reads. */
export const logLines = (out) =>
  out
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** The local estate's compose project prefix: `canari-local-<service>-1`. */
export const localContainer = (service) => `canari-local-${service}-1`;

/**
 * The estate's operations, built from `site` and the transports that reach it.
 *
 * Refuses at CONSTRUCTION, before any transport exists to be called: an `EstateRefusedError` here is
 * thrown at the import of `estate.mjs`, so a rig pointed at production stops before its first line.
 *
 * @param {object} deps
 * @param {string} deps.site the configured `SITE`
 * @param {string | undefined} deps.devSshHost the ssh alias of the host carrying dev (machine-local, from `names.mjs`)
 * @param {(args: string[], opts?: object) => string} deps.docker runs the LOCAL `docker` CLI, returns stdout
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string, error?: Error}} deps.dockerSpawn
 *   runs the LOCAL `docker` CLI and returns both streams (for `docker logs`, whose ERROR lines are on stderr)
 * @param {(host: string, command: string, opts?: object) => string} deps.ssh runs one command on a remote host
 */
export function makeEstate({ site, devSshHost, docker, dockerSpawn, ssh }) {
  const ESTATE = estateOf(site);
  if (ESTATE === 'dev' && !(typeof devSshHost === 'string' && /^[A-Za-z0-9._-]+$/.test(devSshHost))) {
    throw new EstateRefusedError(
      site,
      'no-dev-host',
      'REFUSED: SITE is dev but names.mjs exports no DEV_SSH_HOST - the ssh alias of the host carrying the ' +
        `'${DEV_PROJECT}' compose project. It is machine-local wiring and lives there, never in this repository.`,
    );
  }
  const LOCAL = ESTATE === 'local';

  const localExec = (service, command, opts) =>
    docker(['exec', localContainer(service), 'sh', '-lc', command], { maxBuffer: 256 * 1024 * 1024, ...opts }).trim();

  /** `redis-cli <args...>` in the estate's Redis. Arguments are already shell-quoted by the caller. */
  const redis = (args, opts) =>
    LOCAL ? localExec('redis', `redis-cli ${args}`, opts) : ssh(devSshHost, devExecCommand('redis', `redis-cli ${args}`), opts);

  /**
   * `sql` on the estate's database, tuples-only and unaligned.
   *
   * The local superuser is `admin` (`infrastructure/local/docker-compose.yml`); dev's user is read
   * from its container. A WRITE is allowed on these two estates only - dev is a fictional-seed
   * estate whose owner allowed campaign writes - and there is no third one this could reach.
   */
  const psql = (sql, opts) =>
    LOCAL
      ? localExec('postgres', `psql -U admin -d auth_db -tAc "${sql.replace(/"/g, '\\"')}"`, { timeoutMs: 60_000, ...opts })
      : ssh(devSshHost, devPsqlCommand(sql), { timeoutMs: 60_000, ...opts });

  /** One service's log lines in the window, both streams, ANSI stripped, blanks dropped. */
  const srvLines = (service, since) => {
    if (LOCAL) {
      const r = dockerSpawn(['logs', '--since', since, localContainer(service)]);
      if (r.error || r.status !== 0) throw new Error(`docker logs ${localContainer(service)} failed: ${r.error ?? r.stderr}`);
      return logLines(`${r.stdout}\n${r.stderr}`);
    }
    return logLines(ssh(devSshHost, devLogsCommand(service, since), { timeoutMs: 90_000 }));
  };

  /**
   * The containers a run is about to address, resolved now and named - the check a run makes on its
   * target before it starts. On dev it RESOLVES each by label on the host (read-only `docker ps` and
   * `docker inspect`), so a missing or ambiguous container fails here rather than mid-row.
   *
   * @param {string[]} services
   * @returns {string[]} one `service -> container` line per service
   */
  const verifyTarget = (services = ['postgres', 'redis']) =>
    services.map((service) =>
      LOCAL
        ? `${service} -> ${docker(['inspect', '-f', '{{.Name}}', localContainer(service)]).trim().replace(/^\//, '')}`
        : `${service} -> ${ssh(devSshHost, `${devResolveContainer(service)}; echo "$c"`, { timeoutMs: 30_000 })}`,
    );

  return { ESTATE, LOCAL, DEV: ESTATE === 'dev', redis, psql, srvLines, verifyTarget };
}
