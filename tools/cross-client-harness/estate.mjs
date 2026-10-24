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
 * So the target follows `SITE`, exactly as `APP_TAB` does. There is no flag and no fallback.
 *
 * **THREE ESTATES, NOT TWO, AND THE THIRD IS A REFUSAL (2026-10-24).** Until then `LOCAL` was a
 * boolean and everything not local was routed to PRODUCTION's containers - so pointing `SITE` at dev
 * would have read production and called it dev. Now an estate is `local` or `dev`, and anything else
 * throws `EstateRefusedError` AT THE IMPORT of this module, before a single command exists to be run.
 * There is no code path left that reaches production's containers. The routing and its refusals are
 * pure and live in `estate-target.mjs`, where `archive/estate-selftest.mjs` drives them with stubs;
 * this module only plugs the real transports in.
 *
 * **AND THAT IS WHY THIS IS ITS OWN MODULE RATHER THAN TWO MORE EXPORTS IN `ssh.mjs`.** Reading
 * `SITE` means importing `names.mjs`, which is gitignored - it holds real display names and this
 * repository is PUBLIC - so a module that imports it cannot be imported on a fresh checkout at all.
 * Putting these two functions in `ssh.mjs` made `srvlog.mjs` and `devices.mjs` unimportable in CI,
 * and `gate-selftest.mjs` caught it the same hour. **A transport is machine-agnostic and an ESTATE is
 * not**, so they are different modules.
 *
 *   bun estate.mjs        names the estate, resolves its containers (read-only) and prints them
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as NAMES from './names.mjs';
import { makeEstate } from './estate-target.mjs';
import { SITE } from './site.mjs';
import { ssh } from './ssh.mjs';

/**
 * The estate's operations. `DEV_SSH_HOST` is the ssh alias of the host carrying dev's compose
 * project: machine-local wiring, read from `names.mjs` and never spelt in this public repository.
 * Read through the namespace so a `names.mjs` that predates it still imports for a LOCAL run.
 */
const E = makeEstate({
  site: SITE,
  devSshHost: NAMES.DEV_SSH_HOST,
  docker: (args, opts) => execFileSync('docker', args, { encoding: 'utf8', ...opts }),
  dockerSpawn: (args) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }),
  ssh,
});

/** `'local'` or `'dev'` - never anything else; any other `SITE` threw above. */
export const ESTATE = E.ESTATE;

/**
 * Whether the campaign's target is on this machine.
 *
 * EXPORTED because "which estate" decides more than which container to talk to. `results.mjs` needs
 * it to know which git history contains the bundle a client is running: a deployment is built by CD
 * from a commit on `origin/main`, and the local estate is built by `make local-frontend` from the
 * WORKING TREE. Same question, same answer, one place.
 */
export const LOCAL = E.LOCAL;

/** Whether the campaign's target is `dev.canari-emse.fr`. */
export const DEV = E.DEV;

/** `redis-cli <args...>` inside the estate's Redis container. Arguments are already quoted by the caller. */
export const redis = E.redis;

/**
 * Runs `sql` on the estate's database, tuples-only and unaligned.
 *
 * THE ROLE DIFFERS BETWEEN THE ESTATES, and it is not a detail. Restoring a dump locally recreates
 * its owning role WITHOUT LOGIN, so a local `psql -U canari` answers `FATAL: role "canari" is not
 * permitted to log in`, which reads exactly like a permissions problem with the query. The local
 * superuser is `admin`, declared in `infrastructure/local/docker-compose.yml`; dev's is read from its
 * own container's `POSTGRES_USER`.
 */
export const psql = E.psql;

/**
 * One service's log lines in the window, from WHICHEVER ESTATE `SITE` NAMES - ANSI stripped, blanks
 * dropped, BOTH streams (Nest writes its ERROR lines to stderr: GRAINE-AUTH-3 failed on a
 * `[CHANNEL_KEY_REUSED]` line that only stderr carried, 2026-10-05).
 *
 * THE THIRD OBSERVER NEVER FOLLOWED THE CAMPAIGN OFF PRODUCTION once before: when the rig moved to
 * the local estate this reader kept reading production, and COMM-14 recorded FAIL on 2026-09-05
 * while the phone's tray held both notifications - the instrument had read production, where the
 * run's channel id never existed. An absence in the wrong estate is indistinguishable from a
 * decision not taken, which is why it now goes through the same allowlist as `psql`.
 *
 * @param {string} service the compose service name, e.g. `social-service`
 * @param {string} since a docker `--since` value: an ISO instant, or `900s`
 * @returns {string[]} the window's lines, trimmed, in order
 */
export const srvLines = E.srvLines;

/** Resolves and names the containers a run will address (read-only); throws if any is missing. */
export const verifyTarget = E.verifyTarget;

/** The local estate's chat gateway container: the compose project prefix plus the service name. */
export const LOCAL_GATEWAY_CONTAINER = 'canari-local-chat-gateway-1';

/**
 * CUTS EVERY ESTABLISHED WEBSOCKET, THE ONLY WAY KNOWN TO WORK ON THE PHONE: restart the gateway.
 *
 * It is how a STREAM GAP is made on a client (Mi 9T pass D1-D6, 2026-10-06: D1 used it, and the
 * socket dropped and reopened as the app's reconnect expects). The obvious lever does NOT do it:
 * `adb reverse --remove` closes the LISTENER while the socket the app already holds keeps carrying
 * data, so D5 saw no gap at all - `estateReverse` in `a1apk.mjs` says so, and so does LIFE-6 on the
 * board, which measured the same on 2026-09-07. `archive/net.mjs` is the web client's equivalent.
 *
 * LOCAL ESTATE ONLY, and it throws rather than reaching for another one: restarting dev's gateway
 * would drop every tester's socket. There is no remote branch to fall back to.
 *
 * @returns {string} the container that was restarted
 */
export function restartGateway() {
  if (!LOCAL) {
    throw new Error(
      `restartGateway: SITE ${SITE} is not the local estate - a gateway restart drops every member's socket`
    );
  }
  console.log(`[estate] docker restart ${LOCAL_GATEWAY_CONTAINER}`);
  execFileSync('docker', ['restart', LOCAL_GATEWAY_CONTAINER], { encoding: 'utf8' });
  return LOCAL_GATEWAY_CONTAINER;
}

if (import.meta.main) {
  console.log(`[estate] SITE ${SITE} -> estate '${ESTATE}'`);
  for (const line of verifyTarget()) console.log(`[estate]   ${line}`);
}
