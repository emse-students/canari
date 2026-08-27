/**
 * TEMPLATE for the ONE machine-local file this rig needs. Setting it up is two steps, because the
 * values and the pointer live on opposite sides of the repository boundary.
 *
 *   1. Create `<repo>/../canari-harness/` and put the REAL values there, in a `names.mjs` holding
 *      everything below except `STATE_DIR`. Put `test-accounts.json` beside them (see
 *      `test-accounts.example.json`), and let the Chrome profiles, the debug APK, the phone baseline
 *      and `results.ndjson` accumulate there too.
 *   2. Copy this file to `names.mjs` HERE, and replace its body with the two lines at the bottom:
 *      a re-export of that file, and `STATE_DIR` pointing at it.
 *
 * WHY THE SPLIT. `emse-students/canari` is public and the campaign runs against PRODUCTION with two
 * real accounts. A credential inside the work tree is protected by a `.gitignore` rule, which is a
 * policy; kept outside it cannot be committed at all, which is a structure. The Chrome profiles are
 * outside for a second reason: they ARE the W1 and W2 devices - profile holds the MLS identity, the
 * session and the enrolment - and `git clean -xdf` does not spare a gitignored directory. Losing
 * them costs a re-enrolment and the 2FA step no tool here can answer.
 *
 * WHY ANY OF IT IS CENTRAL. A check must IMPORT from `names.mjs` and never spell a name inline.
 * That is not a style rule: a spelt name is how the peer's real identity reached the public archive
 * once already, and around thirty copies of the same string had drifted into two different spellings
 * before this file existed - which does not fail loudly. A check that clicks a name nobody renders
 * opens NOTHING and then reports on whatever conversation happened to be on screen.
 */

/** The account that owns W1 and A1, as W2 sees it in its sidebar. A DISPLAY name, not a login. */
export const OWNER_NAME = "<owner display name>";

/** The account that owns W2, as W1 sees it in its sidebar. A DISPLAY name, not a login. */
export const PEER_NAME = "<peer display name>";

/**
 * The site, as an ABSOLUTE url.
 *
 * Navigation used to be written `location.origin + '/chat'`, which reads as harmless and is not: on
 * a freshly opened tab the document is `about:blank`, whose origin is the STRING "null", so the
 * result is not a URL and the navigation throws `Failed to set the 'href' property on 'Location'`.
 * That is a state the harness creates on purpose - every relaunched browser and every spare tab
 * starts there - so anything that recovers a client must not depend on the client already being
 * somewhere.
 */
export const SITE = "https://canari-emse.fr";

/**
 * Devtools ports. The Chrome profiles ARE the devices; A1 is an adb forward.
 *
 * W3 IS THE SCRATCH DEVICE, and the only one anything here may wipe. It holds the OWNER account,
 * like W1 and A1, and exists so the HEAL-NEW rows can produce a client that has never seen this
 * account without spending a 2FA per row: `newdevice.mjs` clears the CANARI ORIGIN only, which is
 * where the device identity lives (`mls_device_id_<userId>` in localStorage, the MLS state in
 * IndexedDB), and leaves the CAS and Authentik sessions untouched on their own origins. The PIN is
 * account-level, so the fresh device enters the same one. `newdevice.mjs` refuses any other device
 * by name - see its `WIPEABLE`.
 */
export const PORTS = { W1: 9224, W2: 9223, A1: 9333, W3: 9225 };

/**
 * WHERE EACH DEVICE'S APP LIVES. The phone's is NOT the site's.
 *
 * The mobile app serves its own frontend from `tauri.localhost`, and the Tauri capability allowlist
 * is scoped to that origin. Navigating the phone's WebView to `SITE` therefore does not "reload the
 * app": it leaves the app, and the plugins go with it. The screen then reads
 * `http.fetch not allowed on window "main", webview "main", URL: https://canari-emse.fr/chat` -
 * every request fails, the PIN modal can never settle, and no error is shown either, so the client
 * looks stuck rather than misplaced. That cost an unlock two timeouts before it was read.
 *
 * So route by DEVICE, never by the one constant that happens to be a URL. `SITE` remains what the
 * browsers load and what a link points at; it is not where the phone runs.
 */
export const ORIGIN = { W1: SITE, W2: SITE, W3: SITE, A1: "http://tauri.localhost" };

/**
 * Which account key in `test-accounts.json` each device is logged in as.
 *
 * `pin.mjs` used to take the account by name, so unlocking a client meant remembering which of the
 * two owned it - and the wrong answer does not error, it types the other account's PIN and reports
 * "PIN incorrect" about a PIN that is perfectly correct. The device is the thing a caller actually
 * knows, so it is the thing to pass: `node pin.mjs --device W1`.
 */
export const ACCOUNT_OF = {
  W1: "<owner key>",
  A1: "<owner key>",
  W3: "<owner key>",
  W2: "<peer key>",
};

/**
 * The phone's wireless adb endpoint, tried when the USB link has dropped.
 *
 * USB is preferred - the LIFE phase cuts the radios, and a wireless transport dies with the wifi it
 * rides on - so this is a fallback and never the default. It is only reachable if `adb tcpip 5555`
 * has been run since the last reboot, and the address changes with the subnet, which is why nothing
 * may depend on it succeeding.
 */
export const A1_WIFI = "<phone ip>:5555";

/**
 * The name a given client must click to reach the shared DM - i.e. the OTHER party's name.
 * A1 holds the same account as W1, so it looks for the peer just as W1 does.
 */
export const peerNameFor = (device) => (device === "W2" ? OWNER_NAME : PEER_NAME);

/** The campaign's channel venue. Never MiTV: a private channel is readable by every asso admin. */
export const VENUE = { community: "Campagne de test", channel: "general" };

/*
 * ---------------------------------------------------------------------------------------------
 * THE TWO LINES THE COPY IN THIS DIRECTORY ACTUALLY CONTAINS, replacing everything above:
 *
 *   import { fileURLToPath } from 'node:url';
 *   export * from '../../../canari-harness/names.mjs';
 *   export const STATE_DIR = fileURLToPath(new URL('../../../canari-harness/', import.meta.url));
 *
 * `STATE_DIR` has exactly three consumers - `launch.mjs` for the profiles, `accounts.mjs` for the
 * logins, `results.mjs` for the verdict record - and nothing else needs to know the split exists.
 * ---------------------------------------------------------------------------------------------
 */
