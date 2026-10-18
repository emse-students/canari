#!/usr/bin/env bun
/**
 * A REAL SIGN-IN AGAINST THE DEV ESTATE, run by `serve-dev.yml` after the deploy and before the
 * `dev-deployed` marker moves.
 *
 * WHY. On 2026-09-06 `v0.16.4` deployed green, both estates answered `HTTP 200` and every login was
 * refused. `deployed-wasm-check.mjs` names that ONE class from the outside; it is not a login, and a
 * defect that needs a session (the OIDC exchange, the token mint, the auth_request that guards every
 * route) is invisible to it. This walks the whole path a browser walks: MiConnect's flow executor,
 * the authorization code, `POST /api/auth/oidc/callback`, then an authenticated request.
 *
 * DEV ONLY, BY CONSTRUCTION. The workflow that calls it is `serve-dev.yml`; the credentials are
 * `DEV_SMOKE_*` secrets of the `development` environment. No production credential exists in GitHub
 * (user, 2026-10-18).
 *
 * ABSENT CREDENTIALS ARE A NAMED, LOUD SKIP, never a silent one: a workflow warning and a line in the
 * run summary say that NO sign-in was tried, so a green deploy cannot be read as a tested login. A
 * REFUSED sign-in exits 1 with the stage it died at and the reason, never the password.
 *
 * Exit codes: 0 signed in (or skipped, loudly), 1 the sign-in was refused or the estate is wrong.
 *
 * Environment (all read here, none is argv - a credential must not be a process argument):
 *   SMOKE_ORIGIN         the estate's web origin, e.g. https://dev.canari-emse.fr
 *   SMOKE_IDP_URL        MiConnect's base URL
 *   SMOKE_CLIENT_ID      the OIDC client id the web app uses
 *   SMOKE_USERNAME / SMOKE_PASSWORD   the dedicated dev-only account (absent -> loud skip)
 *   SMOKE_FLOW_SLUG      optional - the flow to start from; absent, the authorize endpoint names it
 *
 *   bun .github/scripts/smoke-login.mjs
 */
import { appendFileSync } from 'node:fs';

/** The scopes the web client asks for (`startOidcLogin` in `frontend/src/lib/stores/auth.ts`). */
const SCOPE = 'openid profile promo name formation';
/** A flow is a handful of stages; more than this is a loop, not a slow login. */
const MAX_STAGES = 12;
/** A redirect chain longer than this is a loop. */
const MAX_HOPS = 10;

/** A refused sign-in, carrying the stage it died at. */
export class SmokeError extends Error {
  /** @param {string} stage where the walk stopped @param {string} detail why */
  constructor(stage, detail) {
    super(`${stage}: ${detail}`);
    this.stage = stage;
  }
}

/** A tiny cookie jar: name -> value, enough for the IdP session and its CSRF cookie. */
export class Jar {
  #cookies = new Map();
  /** Stores every `Set-Cookie` of a response. */
  absorb(res) {
    const lines = res.headers.getSetCookie?.() ?? [];
    for (const line of lines) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  /** The value of one cookie, or undefined. */
  get(name) {
    return this.#cookies.get(name);
  }
  /** The `Cookie` request header. */
  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/**
 * Decides what the run does with the credentials it was given. Pure, so the skip is TESTED rather
 * than trusted: both absent is a skip, one absent is a configuration error (a half-created secret
 * pair must not read as "not configured").
 * @returns {'run'|'skip'}
 */
export function credentialsVerdict({ username, password }) {
  const u = Boolean(username);
  const p = Boolean(password);
  if (u && p) return 'run';
  if (!u && !p) return 'skip';
  throw new SmokeError(
    'configuration',
    `only one of DEV_SMOKE_USERNAME / DEV_SMOKE_PASSWORD is set (${u ? 'username' : 'password'} present) - create both or neither`
  );
}

/**
 * Pulls the authorization code out of a redirect target when it points at `redirectUri`.
 * @returns {string|null}
 */
export function codeFromLocation(location, redirectUri, base) {
  let target;
  try {
    target = new URL(location, base);
  } catch {
    return null;
  }
  const want = new URL(redirectUri);
  if (target.origin !== want.origin || target.pathname !== want.pathname) return null;
  const error = target.searchParams.get('error');
  if (error) {
    throw new SmokeError(
      'authorize',
      `MiConnect redirected back with error=${error} (${target.searchParams.get('error_description') ?? 'no description'})`
    );
  }
  return target.searchParams.get('code');
}

/** The flow slug in an `/if/flow/<slug>/` path, or null. */
export function flowSlugFromLocation(location, base) {
  const m = new URL(location, base).pathname.match(/\/if\/flow\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * The body that answers one stage, or a SmokeError naming a stage this account cannot pass.
 * Never includes the password in an error.
 */
export function answerStage(challenge, { username, password }) {
  switch (challenge.component) {
    case 'ak-stage-identification':
      return {
        component: challenge.component,
        uid_field: username,
        // A flow may ask for the password on the identification stage itself.
        ...(challenge.password_fields ? { password } : {}),
      };
    case 'ak-stage-password':
      return { component: challenge.component, password };
    case 'ak-stage-consent':
      return { component: challenge.component, token: challenge.token };
    case 'ak-stage-user-login':
    case 'ak-stage-autosubmit':
      return { component: challenge.component };
    default:
      throw new SmokeError(
        'flow',
        `the flow asked for a stage this account cannot answer: ${challenge.component} (a second factor on the smoke account?)`
      );
  }
}

/**
 * Walks the whole sign-in and returns what was proven.
 * @param {object} o
 * @param {typeof fetch} [o.fetchImpl] injectable so the test runs against a local fake
 * @param {(line: string) => void} [o.log]
 */
export async function smokeLogin(o) {
  const { origin, idpUrl, clientId, username, password, flowSlug } = o;
  const fetchImpl = o.fetchImpl ?? fetch;
  const log = o.log ?? ((l) => console.log(l));
  const redirectUri = `${origin.replace(/\/+$/, '')}/auth/callback`;
  const idp = idpUrl.replace(/\/+$/, '');
  const jar = new Jar();
  const stages = [];

  /** One request with the jar, never following a redirect (the code is IN the redirect). */
  const send = async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    const cookie = jar.header();
    if (cookie) headers.Cookie = cookie;
    const res = await fetchImpl(url, {
      ...init,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    jar.absorb(res);
    return res;
  };

  const authorizePath = `/application/o/authorize/?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state: crypto.randomUUID(),
  })}`;

  /** Follows redirects from `url` until one names the redirect URI (the code) or a flow page. */
  const chase = async (url) => {
    let current = url;
    let slug = null;
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const res = await send(current);
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) {
        return { code: null, slug };
      }
      const code = codeFromLocation(location, redirectUri, current);
      if (code) return { code, slug };
      slug = flowSlugFromLocation(location, current) ?? slug;
      current = new URL(location, current).toString();
    }
    throw new SmokeError('authorize', `more than ${MAX_HOPS} redirects without a code`);
  };

  log(`smoke-login: starting at ${idp} as the dedicated smoke account`);
  const start = flowSlug
    ? `${idp}/if/flow/${flowSlug}/?next=${encodeURIComponent(authorizePath)}`
    : `${idp}${authorizePath}`;
  let { code, slug } = await chase(start);
  slug = flowSlug ?? slug;

  if (!code) {
    if (!slug) {
      throw new SmokeError(
        'authorize',
        'the authorize endpoint named no flow and returned no code - is the client id right?'
      );
    }
    const executor = `${idp}/api/v3/flows/executor/${slug}/`;
    const query = `?query=${encodeURIComponent(flowSlug ? `next=${authorizePath}` : authorizePath.split('?')[1])}`;
    let res = await send(`${executor}${query}`, { headers: { Accept: 'application/json' } });
    for (let n = 0; n < MAX_STAGES && !code; n += 1) {
      if (!res.ok) throw new SmokeError('flow', `the flow executor answered HTTP ${res.status}`);
      const challenge = await res.json();
      stages.push(challenge.component);
      if (challenge.component === 'xak-flow-redirect') {
        const found = codeFromLocation(challenge.to, redirectUri, idp);
        if (found) {
          code = found;
          break;
        }
        ({ code } = await chase(new URL(challenge.to, idp).toString()));
        if (!code)
          throw new SmokeError(
            'flow',
            `the final redirect carried no code (${stages.join(' > ')})`
          );
        break;
      }
      const body = answerStage(challenge, { username, password });
      const csrf = jar.get('authentik_csrf');
      res = await send(`${executor}${query}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'X-authentik-CSRF': csrf } : {}),
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        // A refused field comes back as a 200 challenge carrying `response_errors`.
        const peek = await res.clone().json();
        const errors = peek.response_errors;
        if (errors && Object.keys(errors).length > 0) {
          throw new SmokeError(
            challenge.component,
            `MiConnect refused the answer (${Object.keys(errors).join(', ')}) - wrong username or password for the smoke account`
          );
        }
      }
    }
    if (!code)
      throw new SmokeError('flow', `no code after ${MAX_STAGES} stages (${stages.join(' > ')})`);
  }
  log(`smoke-login: MiConnect issued a code (stages: ${stages.join(' > ') || 'none'})`);

  const cb = await fetchImpl(`${origin.replace(/\/+$/, '')}/api/auth/oidc/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(30_000),
  });
  if (cb.status !== 200) {
    const text = (await cb.text().catch(() => '')).slice(0, 300);
    throw new SmokeError(
      'oidc-callback',
      `POST /api/auth/oidc/callback answered HTTP ${cb.status}: ${text}`
    );
  }
  const session = await cb.json();
  if (!session.access_token || !session.user?.id) {
    throw new SmokeError(
      'oidc-callback',
      'the callback answered 200 without an access token and a user'
    );
  }
  log('smoke-login: the callback minted a session');

  const verify = await fetchImpl(`${origin.replace(/\/+$/, '')}/api/auth/verify`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (verify.status !== 200 || verify.headers.get('x-logged-in') !== 'true') {
    throw new SmokeError(
      'verify',
      `the minted token was not accepted: HTTP ${verify.status}, X-Logged-In=${verify.headers.get('x-logged-in')}`
    );
  }
  log('smoke-login: the token is accepted by the auth_request that guards every route');
  return { stages, userId: session.user.id };
}

/** Appends a block to the run summary when one exists. */
function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

async function main() {
  const env = process.env;
  let verdict;
  try {
    verdict = credentialsVerdict({ username: env.SMOKE_USERNAME, password: env.SMOKE_PASSWORD });
  } catch (err) {
    console.log(`::error title=Smoke sign-in misconfigured::${err.message}`);
    summary(`### Smoke sign-in: MISCONFIGURED\n\n${err.message}`);
    process.exit(1);
  }
  if (verdict === 'skip') {
    const msg =
      'NO sign-in was tried: DEV_SMOKE_USERNAME and DEV_SMOKE_PASSWORD are not set on the development environment (docs/wiki/cicd.md, "The smoke sign-in"). This deploy proves the containers started and the wasm cannot panic; it does NOT prove a login works.';
    console.log(`::warning title=Smoke sign-in SKIPPED::${msg}`);
    summary(`### Smoke sign-in: SKIPPED\n\n${msg}`);
    return;
  }
  for (const k of ['SMOKE_ORIGIN', 'SMOKE_IDP_URL', 'SMOKE_CLIENT_ID']) {
    if (!env[k]) {
      console.log(`::error title=Smoke sign-in misconfigured::${k} is empty`);
      summary(`### Smoke sign-in: MISCONFIGURED\n\n${k} is empty`);
      process.exit(1);
    }
  }
  try {
    const out = await smokeLogin({
      origin: env.SMOKE_ORIGIN,
      idpUrl: env.SMOKE_IDP_URL,
      clientId: env.SMOKE_CLIENT_ID,
      username: env.SMOKE_USERNAME,
      password: env.SMOKE_PASSWORD,
      flowSlug: env.SMOKE_FLOW_SLUG || undefined,
    });
    summary(
      `### Smoke sign-in: PASSED\n\nSigned in on ${env.SMOKE_ORIGIN} (stages: ${out.stages.join(' > ') || 'none'}).`
    );
  } catch (err) {
    const detail = err instanceof SmokeError ? err.message : `unexpected: ${err?.message ?? err}`;
    console.log(`::error title=Smoke sign-in FAILED::${detail}`);
    summary(
      `### Smoke sign-in: FAILED\n\nThe dev estate refused a real sign-in. ${detail}\n\nThe \`dev-deployed\` marker was NOT moved, so no stable can ship this build.`
    );
    process.exit(1);
  }
}

if (import.meta.main) await main();
