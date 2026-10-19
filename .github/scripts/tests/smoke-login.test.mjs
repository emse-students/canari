#!/usr/bin/env bun
/**
 * DOES THE SMOKE SIGN-IN TELL A LOGIN FROM A REFUSAL, AND A SKIP FROM A PASS?
 *
 * `.github/scripts/smoke-login.mjs` walks MiConnect's flow executor, the OIDC callback and the
 * auth_request against a REAL estate; none of that is reachable from here. What is: its decisions.
 * This runs it against a local fake IdP and a local fake backend and asserts the outcomes a workflow
 * run turns into a green or a red deploy - and that a missing credential is a NAMED skip, a
 * half-set pair is an error, and the password never reaches a log line.
 *
 * Usage: bun .github/scripts/tests/smoke-login.test.mjs   (no arguments, no network beyond loopback)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  SmokeError,
  answerStage,
  codeFromLocation,
  credentialsVerdict,
  smokeLogin,
} from '../smoke-login.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../smoke-login.mjs');
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  failures += 1;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

const PASSWORD = 'correct-horse-battery';

/**
 * A fake estate: IdP on one port, backend on another. `mode` shapes what it refuses.
 *
 * The IdP copies the SHAPE MiConnect (authentik 2026.8) showed on 2026-10-18, the first live run:
 * - authorize without a session 302s to the DEFAULT flow page, `/if/flow/cas-only/?<its own
 *   params>&next=<authorize, encoded>`; the page answers 200 and the browser hands the executor its
 *   whole query string;
 * - the default flow identifies anyone, then DENIES a password account (`ak-stage-access-denied`):
 *   it is CAS-only, so the smoke account must start on `password-login`;
 * - an ACCEPTED stage answer is a 302 back to the executor's own URL, a REFUSED one a 200 challenge
 *   carrying `response_errors` - the 302 is what the first run died on;
 * - the last stage is `xak-flow-redirect` to the DECODED `next`, so a `next` passed unencoded loses
 *   everything after its first `&` and the authorize below refuses it;
 * - authorize WITH the session cookie 302s to `redirect_uri` with a code.
 */
function fake(mode) {
  /** Per-session flow state: the pending user and the stage reached, keyed by cookie. */
  const sessions = new Map();
  const sessionOf = (req) => /(?:^|; )sess=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  const idp = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/application/o/authorize/') {
        const sid = sessionOf(req);
        if (sid && sessions.get(sid)?.done) {
          const back = url.searchParams.get('redirect_uri');
          if (!back) return new Response('missing redirect_uri', { status: 400 });
          return new Response(null, {
            status: 302,
            headers: { Location: `${back}?code=abc&state=${url.searchParams.get('state')}` },
          });
        }
        const next = encodeURIComponent(`${url.pathname}${url.search}`);
        return new Response(null, {
          status: 302,
          headers: { Location: `/if/flow/cas-only/?${url.searchParams}&next=${next}` },
        });
      }
      const page = /^\/if\/flow\/([^/]+)\/$/.exec(url.pathname);
      if (page) {
        const sid = crypto.randomUUID();
        sessions.set(sid, { stage: 'identify', done: false });
        return new Response('<html>flow</html>', {
          headers: { 'Set-Cookie': `sess=${sid}; Path=/` },
        });
      }
      const exec = /^\/api\/v3\/flows\/executor\/([^/]+)\/$/.exec(url.pathname);
      if (exec) {
        const slug = exec[1];
        const s = sessions.get(sessionOf(req));
        if (!s) return new Response('no session', { status: 403 });
        const next = new URLSearchParams(url.searchParams.get('query') ?? '').get('next');
        if (req.method === 'GET') {
          if (s.stage === 'identify')
            return Response.json({ component: 'ak-stage-identification' });
          if (s.stage === 'denied')
            return Response.json({
              component: 'ak-stage-access-denied',
              error_message: 'CAS only',
            });
          if (s.stage === 'mfa')
            return Response.json({ component: 'ak-stage-authenticator-validate' });
          if (s.stage === 'password') return Response.json({ component: 'ak-stage-password' });
          s.done = true;
          return Response.json({ component: 'xak-flow-redirect', to: next });
        }
        const body = await req.json();
        const again = new Response(null, {
          status: 302,
          headers: { Location: `${url.pathname}${url.search}` },
        });
        if (body.component === 'ak-stage-identification') {
          s.stage = slug === 'cas-only' ? 'denied' : mode === 'mfa' ? 'mfa' : 'password';
          return again;
        }
        if (body.component === 'ak-stage-password') {
          if (body.password !== PASSWORD) {
            return Response.json({
              component: 'ak-stage-password',
              response_errors: { password: [{ string: 'no' }] },
            });
          }
          s.stage = 'redirect';
          return again;
        }
      }
      return new Response('?', { status: 404 });
    },
  });
  const idpOrigin = `http://127.0.0.1:${idp.port}`;

  const backend = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/auth/oidc/callback') {
        if (mode === 'callback-500') return new Response('boom', { status: 500 });
        return Response.json({ access_token: 't', user: { id: 'u1' } });
      }
      if (url.pathname === '/api/auth/verify') {
        const good = req.headers.get('authorization') === 'Bearer t' && mode !== 'verify-refused';
        return new Response(null, {
          status: good ? 200 : 401,
          headers: { 'X-Logged-In': String(good) },
        });
      }
      return new Response('?', { status: 404 });
    },
  });
  const backendOrigin = `http://127.0.0.1:${backend.port}`;
  return { idp, backend, idpOrigin, backendOrigin };
}

async function run(
  mode,
  creds = { username: 'smoke', password: PASSWORD },
  flowSlug = 'password-login'
) {
  const f = fake(mode);
  const lines = [];
  try {
    const out = await smokeLogin({
      origin: f.backendOrigin,
      idpUrl: f.idpOrigin,
      clientId: 'cid',
      ...creds,
      flowSlug,
      log: (l) => lines.push(l),
    });
    return { out, lines };
  } catch (err) {
    return { err, lines };
  } finally {
    f.idp.stop(true);
    f.backend.stop(true);
  }
}

// --- pure decisions
check(
  credentialsVerdict({ username: 'u', password: 'p' }) === 'run',
  'both credentials set -> run'
);
check(credentialsVerdict({}) === 'skip', 'neither set -> skip');
let half = null;
try {
  credentialsVerdict({ username: 'u' });
} catch (e) {
  half = e;
}
check(
  half instanceof SmokeError && /both or neither/.test(half.message),
  'half a pair is an error, not a skip'
);

check(
  codeFromLocation(
    'https://x.test/auth/callback?code=abc',
    'https://x.test/auth/callback',
    'https://idp'
  ) === 'abc',
  'a redirect to the redirect URI yields its code'
);
check(
  codeFromLocation('/if/flow/svc/', 'https://x.test/auth/callback', 'https://idp') === null,
  'a flow redirect is not a code'
);
let denied = null;
try {
  codeFromLocation(
    'https://x.test/auth/callback?error=access_denied&error_description=nope',
    'https://x.test/auth/callback',
    'https://idp'
  );
} catch (e) {
  denied = e;
}
check(
  denied instanceof SmokeError && /access_denied/.test(denied.message),
  'error= on the redirect is a refusal'
);

let mfa = null;
try {
  answerStage(
    { component: 'ak-stage-authenticator-validate' },
    { username: 'u', password: PASSWORD }
  );
} catch (e) {
  mfa = e;
}
check(
  mfa instanceof SmokeError && /second factor/.test(mfa.message) && !mfa.message.includes(PASSWORD),
  'an unanswerable stage names itself and never the password'
);

// --- the whole walk against the fakes
const pass = await run('ok');
check(!pass.err && pass.out?.userId === 'u1', 'a good account signs in end to end');
check(
  pass.out?.stages.join('>') === 'ak-stage-identification>ak-stage-password>xak-flow-redirect',
  'it walked identification, password, redirect'
);

const wrong = await run('ok', { username: 'smoke', password: 'hunter2-bad' });
check(
  wrong.err instanceof SmokeError && wrong.err.stage === 'ak-stage-password',
  'a wrong password fails AT the password stage'
);
check(
  ![...wrong.lines, wrong.err?.message ?? ''].some((l) => l.includes('hunter2-bad')),
  'the refused password is never printed'
);

const casOnly = await run('ok', undefined, null);
check(
  casOnly.err instanceof SmokeError &&
    casOnly.err.stage === 'flow' &&
    /denied the account on the cas-only flow/.test(casOnly.err.message),
  'the default (CAS-only) flow is a named denial, not an HTTP 302'
);

const second = await run('mfa');
check(
  second.err instanceof SmokeError && second.err.stage === 'flow',
  'a second factor fails at the flow, named'
);

const cb = await run('callback-500');
check(
  cb.err instanceof SmokeError && cb.err.stage === 'oidc-callback' && /500/.test(cb.err.message),
  'a 500 from the callback fails at oidc-callback'
);

const vf = await run('verify-refused');
check(
  vf.err instanceof SmokeError && vf.err.stage === 'verify',
  'a token the auth_request refuses fails at verify'
);

// --- the process: skip is loud and green, failure is red
const base = { ...process.env, GITHUB_STEP_SUMMARY: '' };
delete base.SMOKE_USERNAME;
delete base.SMOKE_PASSWORD;
const skipped = spawnSync('bun', [script], { env: base, encoding: 'utf8' });
check(skipped.status === 0, 'absent credentials exit 0');
check(
  /::warning title=Smoke sign-in SKIPPED::/.test(skipped.stdout),
  'and say so as a named workflow warning'
);

const halfRun = spawnSync('bun', [script], {
  env: { ...base, SMOKE_USERNAME: 'u' },
  encoding: 'utf8',
});
check(
  halfRun.status === 1 && /::error title=Smoke sign-in misconfigured::/.test(halfRun.stdout),
  'half a pair exits 1 as an error'
);

const noOrigin = spawnSync('bun', [script], {
  env: { ...base, SMOKE_USERNAME: 'u', SMOKE_PASSWORD: PASSWORD },
  encoding: 'utf8',
});
check(
  noOrigin.status === 1 && /SMOKE_ORIGIN is empty/.test(noOrigin.stdout),
  'credentials without an estate exit 1'
);
check(
  !noOrigin.stdout.includes(PASSWORD) && !noOrigin.stderr.includes(PASSWORD),
  'the password is in no output'
);

console.log(
  failures === 0 ? '\nsmoke-login: all assertions held' : `\nsmoke-login: ${failures} FAILED`
);
process.exit(failures === 0 ? 0 : 1);
