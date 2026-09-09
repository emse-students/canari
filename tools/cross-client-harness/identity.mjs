/**
 * WHICH ACCOUNT A CLIENT IS ACTUALLY ACTING AS, ASKED OF THE TOKEN AND OF NOTHING ELSE.
 *
 * A false P1 on 2026-09-09 declared every two-client measurement on this rig void: a clean login
 * with the peer's credentials was said to return the owner's access token, so a client showed one
 * identity and acted as another. It was refuted the same day by five measurements, and the cause
 * was in the evidence rather than in the product - an association grant had been aimed at a user
 * resolved by DISPLAY NAME, landed on a different row, and the coupling that followed measured the
 * grant moving rather than the identity. Nothing in the mapping can produce it: `users.id` IS the
 * OIDC subject, and `findOrCreateFromOidc` keys on it, so one login response cannot disagree with
 * itself.
 *
 * What the episode DID prove is that no runner check could have seen it either way. The rig had
 * three strings for one human - a login, a display name and a subject - and only the first two were
 * reachable from code. This module makes the third one reachable, and it is the only one the server
 * decides by.
 *
 * TWO QUESTIONS, ASKED SEPARATELY AND ON PURPOSE. What a client SHOWS is `canari_saved_user`, the
 * key the app writes at login and erases at logout. What a client ACTS AS is the `sub` of its access
 * token. They come from different places and the whole point of asking is that they could disagree.
 *
 * IT COSTS NO TRAFFIC AND NO RELOAD, which is what makes it usable as a preflight and mid-row alike.
 * The access token is published by the app itself into the JS-readable `canari_ws_token` cookie
 * (`setWsSessionCookie` in `frontend/src/lib/stores/auth.ts`) for the WebSocket and the sync calls,
 * so it is the same credential the Bearer header carries - read where the app already put it,
 * instead of waiting for a request to go past. A first attempt reloaded the page and watched nine
 * seconds of its traffic to learn the same fact.
 *
 * `bun identity.mjs` reads every client in `PORTS`; `--device W2` reads one.
 */
import { listTargets, connect, evaluate } from './cdp.mjs';
import { roleForSubject } from './accounts.mjs';
import { PORTS, ORIGIN, ACCOUNT_OF } from './names.mjs';
import { subjectOfToken, describeIdentity, wrongIdentities } from './subject.mjs';

// Re-exported so a caller reaches the whole vocabulary in one import, as `atoms.mjs` asks.
export { subjectOfToken, wrongIdentities };

/**
 * What one connected client shows and what it acts as.
 *
 * `shows` and `actsAs` are ACCOUNT KEYS ("owner", "peer") whenever the subject is one this rig
 * knows, and the raw subject cut to twelve characters when it is not - an unknown subject is a
 * fact worth printing, and a full one is a user id in a PUBLIC repository's tooling output.
 */
export async function identityOf(cx, expected = null) {
  const saved = await evaluate(cx, `localStorage.getItem('canari_saved_user')`);
  const cookie = await evaluate(
    cx,
    `(document.cookie.split('; ').find((c) => c.startsWith('canari_ws_token=')) || '').slice('canari_ws_token='.length)`
  );
  const tokenSub = subjectOfToken(cookie ? decodeURIComponent(cookie) : null);
  return describeIdentity({ saved, tokenSub, expected, roleOf: roleForSubject });
}

/**
 * Every reachable client's identity, against the account `names.mjs` says owns it.
 *
 * A client that is not up is REPORTED rather than skipped: "W2 was not running" and "W2 is the
 * wrong account" are different answers and a caller about to trust two clients needs to tell them
 * apart.
 */
export async function identities(devices = Object.keys(PORTS)) {
  const out = [];
  for (const device of devices) {
    const expected = ACCOUNT_OF[device] ?? null;
    try {
      const targets = await listTargets(PORTS[device], 2000);
      const t = targets.find((x) => x.type === 'page' && x.url?.startsWith(ORIGIN[device]));
      if (!t) {
        out.push({ device, expected, reachable: false, why: `no page on ${ORIGIN[device]}` });
        continue;
      }
      const cx = connect(t.webSocketDebuggerUrl);
      await cx.ready;
      await cx.send('Runtime.enable');
      const id = await identityOf(cx, expected);
      cx.close();
      out.push({ device, expected, reachable: true, ...id });
    } catch (e) {
      out.push({ device, expected, reachable: false, why: e.message });
    }
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = argv.indexOf('--device');
  const rows = await identities(one >= 0 ? [argv[one + 1]] : undefined);
  for (const r of rows) {
    if (!r.reachable) {
      console.log(`${r.device.padEnd(3)} expected ${String(r.expected).padEnd(6)} UNREACHABLE  ${r.why}`);
      continue;
    }
    const verdict = r.correct ? (r.agrees ? 'ok' : 'SHOWS/ACTS DISAGREE') : 'WRONG ACCOUNT';
    console.log(
      `${r.device.padEnd(3)} expected ${String(r.expected).padEnd(6)} shows ${String(r.shows).padEnd(6)} acts as ${String(r.actsAs).padEnd(6)} ${verdict}`
    );
  }
  const bad = wrongIdentities(rows);
  if (bad.length > 0) console.log(`\n${bad.length} client(s) are not the account that owns them.`);
  process.exit(bad.length > 0 ? 1 : 0);
}
