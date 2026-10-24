/**
 * WHICH ESTATE A CLIENT IS ON IS A GATE, AND A GATE THAT ONLY EVER ACCEPTS IS NOT ONE.
 *
 * `pin.mjs` runs on every unlock, on both ways out of the gate, and refuses the run when the client
 * it just unlocked is talking to an estate the rig does not report on. That check decides whether a
 * `+A1` verdict means anything at all: an APK built against production installed with `--no-build`
 * would otherwise run every phone row against the real estate while the ledger recorded localhost.
 *
 * THE PREDICATE LIVED INSIDE THE COMMAND AND WAS THEREFORE TESTED BY NOTHING. Its docstring said it
 * had been *"exercised on five origin sets"* - true once, by hand, on the day it was written. The
 * defect below then shipped inside it and was found by a phase failing, which is the expensive way
 * and the one this rig has a rule against.
 *
 * THE DEFECT, measured on W1 on 2026-09-05: `new URL(name).origin` answers the string `'null'` for
 * every `data:` and `blob:` resource - an OPAQUE origin, with no host to be an estate of. The guard
 * compared `'null'` against `SITE`, found it different, and refused with the loudest sentence it
 * has, telling the reader to rebuild an APK. The offender was the application's own noise texture, a
 * `data:image/svg+xml` in its CSS, on every page. It was INTERMITTENT, which is worse than always
 * wrong: the resource timeline holds 250 entries and a navigation clears it, so whether the texture
 * was still in it depended on how long the tab had been up.
 *
 *   bun archive/estate-selftest.mjs
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estateOriginsAmong, estateVerdict, localAliases, NOT_AN_ESTATE } from '../estate-origins.mjs';
import {
  DEV_PROJECT,
  EstateRefusedError,
  REFUSED_STATUS,
  devExecCommand,
  devLogsCommand,
  devResolveContainer,
  estateOf,
  makeEstate,
  refuseForeignOrigins,
  refuseProductionPage,
} from '../estate-target.mjs';

const SITE = 'http://localhost:8081';
const PROD = 'https://canari-emse.fr';
const DEV = 'https://dev.canari-emse.fr';
const ENGINE = ['http://tauri.localhost', 'http://ipc.localhost'];

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

// ── the five sets the original was exercised on, now asserted rather than remembered ────────────
ok('local only is ACCEPTED', estateVerdict([SITE], SITE).ok);
ok('local behind the engine schemes is ACCEPTED', estateVerdict([...ENGINE, SITE], SITE).ok);
ok('production is REFUSED', !estateVerdict([PROD], SITE).ok);
ok('dev is REFUSED', !estateVerdict([DEV], SITE).ok);
ok('the engine schemes ALONE are refused, as silence', estateVerdict(ENGINE, SITE).reason === 'silent');

// THE STRAY IS THE CASE A WEAKER TEST PASSES. "SITE is among them" would accept this; a client
// calling both is not on the local estate, it is on both, and a verdict taken there says nothing.
const stray = estateVerdict([SITE, PROD], SITE);
ok('local WITH a production stray alongside it is REFUSED', !stray.ok);
ok('and the refusal NAMES the stray, not the whole set', stray.strangers.join() === PROD);

// ── the opaque origin: the defect this file exists for ──────────────────────────────────────────
ok("a data: URI reports 'null', which is not an estate", !estateOriginsAmong(['null']).length);
ok('so local + a data: URI is ACCEPTED', estateVerdict([SITE, 'null'], SITE).ok);
ok(
  'and local + engine + data: is ACCEPTED - the shape a real phone reports',
  estateVerdict([...ENGINE, SITE, 'null'], SITE).ok,
);
ok(
  "'null' ALONE is silence, never a pass - it names no estate to have been right about",
  estateVerdict(['null'], SITE).reason === 'silent',
);
ok('and it cannot rescue a stray either', !estateVerdict(['null', PROD], SITE).ok);

// ── the two facts that must NOT be merged ───────────────────────────────────────────────────────
// "This resource has no host" and "this resource's name could not be read" are different, and only
// the first is harmless. `pin.mjs` maps an unparseable name to `unparseable:<name>` precisely so it
// stays visible; forgiving it here would hide a client fetching something nobody can classify.
const unparseable = estateVerdict([SITE, 'unparseable:weird'], SITE);
ok('an UNPARSEABLE resource name is a stranger, not an opaque origin', !unparseable.ok);
ok('and it is named as the stranger', unparseable.strangers.join() === 'unparseable:weird');

// ── vacuity, the rule this rig applies to every gate ────────────────────────────────────────────
ok('an empty set is a REFUSAL, not a pass', !estateVerdict([], SITE).ok);
ok('and it says WHY - silent, not strangers', estateVerdict([], SITE).reason === 'silent');

// ── the shape of the answer ─────────────────────────────────────────────────────────────────────
ok('duplicates are collapsed', estateOriginsAmong([SITE, SITE, SITE]).join() === SITE);
ok('the excused list is exactly the three that are not estates', NOT_AN_ESTATE.length === 3);
ok('and a passing verdict reports the estate it accepted', estateVerdict([SITE], SITE).estates.join() === SITE);

// ── the iPhone reaches the SAME nginx by this machine's LAN address (2026-10-01) ────────────────
const IFACES = {
  Ethernet: [
    { family: 'IPv4', address: '192.168.1.32' },
    { family: 'IPv6', address: 'fe80::1' },
  ],
  Loopback: [{ family: 4, address: '127.0.0.1' }],
};
const ALIASES = localAliases(SITE, IFACES);
ok('an address this machine HOLDS, on the same port, is an alias', ALIASES.includes('http://192.168.1.32:8081'));
ok('IPv6 is not invented into an alias', ALIASES.every((a) => !a.includes('fe80')));
ok('the iPhone on the LAN alias is ACCEPTED', estateVerdict(['http://192.168.1.32:8081'], SITE, ALIASES).ok);
ok('another workstation on the LAN is still a STRANGER', !estateVerdict(['http://192.168.1.40:8081'], SITE, ALIASES).ok);
ok('the alias cannot rescue a production stray', !estateVerdict(['http://192.168.1.32:8081', PROD], SITE, ALIASES).ok);
ok('a non-local site has no aliases', localAliases(PROD, IFACES).length === 0);

// ── the gateway restart that makes a stream gap (D5, 2026-10-06) names a container that exists ──────
// READ AS TEXT: estate.mjs imports names.mjs, which is local to a rig machine and absent from CI.
{
  const estateSource = readFileSync(new URL('../estate.mjs', import.meta.url), 'utf8');
  const compose = readFileSync(new URL('../../../infrastructure/local/docker-compose.yml', import.meta.url), 'utf8');
  const named = /export const LOCAL_GATEWAY_CONTAINER = '([^']+)';/.exec(estateSource)?.[1] ?? '';
  const service = /^canari-local-(.+)-1$/.exec(named)?.[1] ?? '';
  ok('estate.mjs exports the gateway container in the compose-project shape', service !== '');
  ok('that service is one the local compose file defines', service !== '' && new RegExp(`^  ${service}:`, 'm').test(compose));
  ok('restartGateway refuses a non-local estate', /if \(!LOCAL\) \{\s*throw new Error\(\s*`restartGateway/.test(estateSource));
}

// ── R1 (2026-10-24): THREE ESTATES, AND THE THIRD IS A REFUSAL ──────────────────────────────────
// Until that day `LOCAL` was a boolean and everything not local was routed to PRODUCTION's
// containers, so pointing SITE at dev would have read production and reported it as dev. These
// assertions drive the real routing (`makeEstate`) with STUB transports: what is asserted is which
// host and which command a call would have reached, and that a refused SITE reaches nothing at all.
{
  const refusal = (site) => {
    try {
      estateOf(site);
      return null;
    } catch (e) {
      return e;
    }
  };
  ok('the local estate is accepted', estateOf(SITE) === 'local');
  ok('127.0.0.1 is the local estate too', estateOf('http://127.0.0.1:8081') === 'local');
  ok('dev is accepted, as exactly https on the default port', estateOf(DEV) === 'dev' && estateOf(`${DEV}/chat`) === 'dev');
  for (const prod of [PROD, 'https://canari.emse.fr', 'https://www.canari-emse.fr', `${PROD}/api/version`]) {
    const e = refusal(prod);
    ok(`PRODUCTION ${prod} is REFUSED, typed, reason 'production'`, e instanceof EstateRefusedError && e.reason === 'production');
    ok(`and the refusal says PRODUCTION in words (${prod})`, /PRODUCTION/.test(e?.message ?? ''));
  }
  ok('dev over plain http is refused', refusal('http://dev.canari-emse.fr')?.reason === 'insecure-dev');
  ok('dev on another port is refused', refusal('https://dev.canari-emse.fr:8443')?.reason === 'insecure-dev');
  ok('an undeclared host is refused, not guessed', refusal('https://staging.canari-emse.fr')?.reason === 'unknown');
  ok('a value that is not a URL is refused', refusal('dev')?.reason === 'unparseable');

  // The transports, recorded rather than run.
  const harness = (site, devSshHost = 'dev-host-alias') => {
    const calls = { docker: [], dockerSpawn: [], ssh: [] };
    let built = null;
    let error = null;
    try {
      built = makeEstate({
        site,
        devSshHost,
        docker: (args) => (calls.docker.push(args), 'canari-local-postgres-1\n'),
        dockerSpawn: (args) => (calls.dockerSpawn.push(args), { status: 0, stdout: 'a\n\u001b[32mb\u001b[0m\n', stderr: 'c\n' }),
        ssh: (host, command) => (calls.ssh.push({ host, command }), 'line one\n\nline two'),
      });
    } catch (e) {
      error = e;
    }
    return { calls, built, error };
  };
  const untouched = (c) => c.docker.length + c.dockerSpawn.length + c.ssh.length === 0;

  for (const prod of [PROD, 'https://canari.emse.fr']) {
    const h = harness(prod);
    ok(`makeEstate(${prod}) throws at construction`, h.error instanceof EstateRefusedError && h.built === null);
    ok(`and no transport was touched for ${prod}`, untouched(h.calls));
  }
  {
    const h = harness(DEV, null);
    ok('dev without DEV_SSH_HOST is refused, naming the missing setting', h.error?.reason === 'no-dev-host' && /DEV_SSH_HOST/.test(h.error.message));
    ok('and touched nothing', untouched(h.calls));
    ok('a placeholder host (the example file\'s) is refused the same way', harness(DEV, '<ssh alias>').error?.reason === 'no-dev-host');
  }

  const dev = harness(DEV);
  ok('dev builds, and says it is dev', dev.built?.ESTATE === 'dev' && dev.built.DEV && !dev.built.LOCAL);
  dev.built.psql("SELECT id FROM users WHERE x = 'a$1'");
  dev.built.redis('XLEN some-stream');
  const lines = dev.built.srvLines('core-service', '900s');
  dev.built.verifyTarget(['postgres']);
  const devCommands = dev.calls.ssh.map((c) => c.command);
  ok('every dev call went over ssh to DEV_SSH_HOST, and none to local docker', dev.calls.ssh.length === 4 && dev.calls.ssh.every((c) => c.host === 'dev-host-alias') && dev.calls.docker.length === 0 && dev.calls.dockerSpawn.length === 0);
  ok('every dev command resolves its container by the canari-dev compose LABEL', devCommands.every((c) => c.includes('--filter label=com.docker.compose.project=canari-dev')));
  ok('and re-reads the label on the container before using it', devCommands.every((c) => c.includes('docker inspect -f') && c.includes('!= canari-dev')));
  ok('no dev command names a container, so none can name production\'s', devCommands.every((c) => !/infrastructure-|canari-prod|canari-local/.test(c)));
  ok('psql reaches the postgres service', devCommands[0].includes('com.docker.compose.service=postgres'));
  ok('psql runs as the container\'s own POSTGRES_USER', devCommands[0].includes('printenv POSTGRES_USER') && devCommands[0].includes('psql -X -U "$u" -d auth_db'));
  ok('the SQL is single-quoted, so $1 and quotes reach Postgres intact', devCommands[0].endsWith(`-tAc 'SELECT id FROM users WHERE x = '\\''a$1'\\'''`));
  ok('redis reaches the redis service', devCommands[1].includes('com.docker.compose.service=redis') && devCommands[1].endsWith('docker exec "$c" redis-cli XLEN some-stream'));
  ok('the log window reaches the named service, both streams', devCommands[2].includes('com.docker.compose.service=core-service') && devCommands[2].endsWith('docker logs --since 900s "$c" 2>&1'));
  ok('and its lines come back trimmed, blanks dropped', lines.join('|') === 'line one|line two');
  ok('a service name that is not one is refused before it is spliced into a command', (() => {
    try {
      devResolveContainer('postgres; rm -rf /');
      return false;
    } catch {
      return true;
    }
  })());
  ok('so is a --since that is not one', (() => {
    try {
      devLogsCommand('core-service', '1h; reboot');
      return false;
    } catch {
      return true;
    }
  })());

  const local = harness(SITE);
  local.built.psql('SELECT 1');
  local.built.redis('PING');
  const localLines = local.built.srvLines('core-service', '60s');
  ok('the local estate never reaches ssh', local.calls.ssh.length === 0);
  ok('and addresses the canari-local containers', local.calls.docker.every((a) => a[1]?.startsWith('canari-local-')) && local.calls.dockerSpawn[0]?.at(-1) === 'canari-local-core-service-1');
  ok('the local log reader keeps BOTH streams and strips colour', localLines.join('|') === 'a|b|c');
}

// ── THE RESOLVER IS EXECUTED, NOT ONLY READ: a stub `docker` on PATH, the real shell snippet ──────
// A string test cannot tell a snippet that refuses from one that falls through to `docker exec`
// with an empty name. This runs it under `sh` against four states of a fake daemon.
{
  const sh = spawnSync('sh', ['-c', 'exit 0']);
  if (sh.error) {
    ok('sh is available to execute the resolver (needed by this gate)', false);
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'estate-selftest-'));
    writeFileSync(
      join(dir, 'docker'),
      [
        '#!/bin/sh',
        'case "$1" in',
        '  ps) printf "%b" "$FAKE_PS" ;;',
        '  inspect) printf "%s\\n" "$FAKE_PROJECT" ;;',
        '  exec) shift; echo "EXEC $*" ;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(join(dir, 'docker'), 0o755);
    const run = (ps, project) =>
      spawnSync('sh', ['-c', devExecCommand('postgres', 'psql -c 1')], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, FAKE_PS: ps, FAKE_PROJECT: project },
      });
    const one = run('canari-dev-postgres-1\\n', DEV_PROJECT);
    ok('one running container labelled canari-dev: the command runs IN it', one.status === 0 && one.stdout.trim() === 'EXEC canari-dev-postgres-1 psql -c 1');
    const none = run('', DEV_PROJECT);
    ok(`no container: refused with ${REFUSED_STATUS}, nothing executed`, none.status === REFUSED_STATUS && !none.stdout.includes('EXEC'));
    const two = run('a\\nb\\n', DEV_PROJECT);
    ok(`two containers: refused with ${REFUSED_STATUS}, nothing executed`, two.status === REFUSED_STATUS && !two.stdout.includes('EXEC'));
    const foreign = run('x-postgres-1\\n', 'canari-prod');
    ok(`a container reporting another project: refused with ${REFUSED_STATUS}, nothing executed`, foreign.status === REFUSED_STATUS && !foreign.stdout.includes('EXEC'));
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── A PAGE ALREADY ON PRODUCTION IS REFUSED, WHATEVER SITE SAYS ─────────────────────────────────
{
  const throws = (url) => {
    try {
      refuseProductionPage(url);
      return false;
    } catch (e) {
      return e instanceof EstateRefusedError;
    }
  };
  ok('a tab on production is refused', throws(`${PROD}/chat`) && throws('https://canari.emse.fr/chat'));
  ok('a tab on dev, local, blank or the Tauri scheme is not', !throws(`${DEV}/chat`) && !throws(`${SITE}/chat`) && !throws('about:blank') && !throws('http://tauri.localhost/chat'));
  ok('the identity provider is not production\'s APP, and a login page on it passes', !throws('https://auth.canari-emse.fr/if/flow/x'));
  let foreign = null;
  try {
    refuseForeignOrigins({ W1: DEV, W2: PROD, A1: 'http://tauri.localhost' }, 'dev');
  } catch (e) {
    foreign = e;
  }
  ok('an ORIGIN map with a web device on production is refused while SITE is dev', foreign instanceof EstateRefusedError && /ORIGIN\.W2/.test(foreign.message));
  ok('one whose web devices are all on dev passes', refuseForeignOrigins({ W1: DEV, W2: DEV, I1: 'tauri://localhost' }, 'dev').W1 === DEV);
}

// ── THE DOOR CANNOT BE WALKED AROUND: only site.mjs reads SITE or ORIGIN out of names.mjs ────────
{
  const root = new URL('../', import.meta.url);
  const offenders = [];
  let scanned = 0;
  for (const dir of [root, new URL('./', import.meta.url)]) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.mjs') || name === 'site.mjs') continue;
      const source = readFileSync(new URL(name, dir), 'utf8');
      scanned++;
      for (const m of source.matchAll(/^\s*(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]\.\.?\/names\.mjs['"]/gm)) {
        if (/\b(SITE|ORIGIN)\b/.test(m[1])) offenders.push(name);
      }
      if (/import\(\s*['"]\.\.?\/names\.mjs['"]\s*\)\)?\.(SITE|ORIGIN)/.test(source)) offenders.push(name);
    }
  }
  ok(`no rig file but site.mjs takes SITE or ORIGIN from names.mjs (${scanned} scanned)`, scanned > 100 && offenders.length === 0);
  if (offenders.length) console.log(`         offenders: ${offenders.join(' ')}`);
  for (const file of ['../estate.mjs', '../estate-target.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    ok(`${file.slice(3)} names no production container or project`, !/infrastructure-|canari-prod/.test(source));
  }
}

console.log(
  failures
    ? `[estate] ${failures} FAILURE(S) - the gate deciding which estate the rig addresses does not hold`
    : '[estate] clean - local and dev only, production refused before any transport, dev addressed by label',
);
process.exit(failures ? 1 : 0);
