#!/usr/bin/env node
/**
 * CREATE THE APP STORE VERSION, PUT THE BUILD IN IT, AND SUBMIT IT FOR REVIEW.
 *
 * WHAT WAS MISSING. `ios.yml` ended at `xcrun altool --upload-app`, which hands the binary to App
 * Store Connect and leaves it in TestFlight. Nothing created an App Store version, nothing attached
 * a build to one, and nothing submitted anything - the workflow said so itself: "submission is
 * still a manual act in App Store Connect". So a stable release put Android on the Play `production`
 * track by itself and left iOS waiting on a human gesture that nothing asked for and nothing
 * reminded anybody about. That was the only asymmetry between two paths meant to be equivalent.
 *
 * WHY A NODE SCRIPT AND NOT MORE SHELL. The App Store Connect API is authenticated with an ES256
 * JWT, and signing one in bash means openssl plus a DER-to-raw signature conversion by hand. Node
 * does it in six lines and is already how this repository writes its tooling (`tools/play-vitals/`).
 * The whole job is one file with one entry point, which is the opposite of the sprawl this replaces.
 *
 * EVERY STEP IS IDEMPOTENT, because a re-run is an ordinary event: a release can be re-published,
 * and the workflow has a hand-dispatched path for re-running a chain that died on an infrastructure
 * fault. So each step asks what already exists before creating anything, and a version that is
 * already submitted is reported as done rather than submitted twice.
 *
 * WHAT IT REFUSES TO GUESS. Apple REQUIRES release notes and refuses a submission without them.
 * Learning that by being refused at the END of a release - after the bump, the production deploy,
 * the Play publish and a twenty-minute macOS build, with the other store already shipped - is
 * exactly the shape this project spends its gates avoiding. So the notes come from a file in the
 * repository, that file NAMES THE VERSION it was written for, and `release-preflight.sh` runs the
 * same check through `--check-notes` before anything moves at all.
 *
 * Usage: node tools/app-store/submit.mjs
 *        node tools/app-store/submit.mjs --check-notes   # the notes rule alone, no credentials
 *   env  ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8 (base64 of the .p8)
 *        APP_BUNDLE_ID     the app to act on
 *        MARKETING_VERSION the versionString, e.g. 0.15.0 - numeric, no pre-release suffix
 *        BUILD_NUMBER      the CFBundleVersion the bump wrote, e.g. 1500099
 *        WHATS_NEW_FILE    optional path; defaults to store/whats-new.txt
 *        DRY_RUN           set to 1 to read everything and change nothing
 */

import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const API = 'https://api.appstoreconnect.apple.com';
const PLATFORM = 'IOS';

/** Apple's own limit on the release-notes field. Longer text is refused by the API, not truncated. */
const WHATS_NEW_MAX = 4000;

/**
 * A build Apple has finished processing. `PROCESSING` is the state a fresh upload sits in for
 * several minutes; `INVALID` and `FAILED` are terminal and must never be waited on.
 */
const BUILD_READY = 'VALID';
const BUILD_TERMINAL_BAD = new Set(['INVALID', 'FAILED']);

/**
 * The version states an automated run may write into. Anything else is a version a human is
 * already working on, or one the store has published, and both are answers rather than obstacles.
 */
const VERSION_EDITABLE = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);
const VERSION_IN_REVIEW = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE']);
const VERSION_DONE = new Set([
  'READY_FOR_SALE',
  'PENDING_APPLE_RELEASE',
  'PROCESSING_FOR_APP_STORE',
]);

// -------------------------------------------------------------------------------------------------
// Authentication
// -------------------------------------------------------------------------------------------------

/**
 * A 20-minute App Store Connect token.
 *
 * `ieee-p1363` IS NOT OPTIONAL. Node signs ECDSA as DER by default and a JWT requires the raw
 * r||s pair; a DER signature is accepted by no verifier and comes back as a flat 401 that says
 * nothing about why. Apple also caps the lifetime at 20 minutes and rejects anything longer.
 *
 * @param {{keyId: string, issuerId: string, privateKey: string}} creds
 * @returns {string}
 */
export function mintToken({ keyId, issuerId, privateKey }) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuerId, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' };

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${b64(header)}.${b64(payload)}`;

  const signer = createSign('SHA256');
  signer.update(signingInput);
  const sig = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${signingInput}.${sig}`;
}

// -------------------------------------------------------------------------------------------------
// Decisions worth testing on their own
// -------------------------------------------------------------------------------------------------

/**
 * What to do about a build's processing state.
 *
 * Kept separate because the interesting arms are the ones a live run reaches once and never again:
 * a build Apple rejected during processing, and a state Apple adds later that this script has
 * never seen. Waiting for ever on either is the failure mode.
 *
 * @param {string | undefined} state
 * @returns {{action: 'use'} | {action: 'wait'} | {action: 'fail', why: string}}
 */
export function classifyBuildState(state) {
  if (state === BUILD_READY) return { action: 'use' };
  if (state === 'PROCESSING') return { action: 'wait' };
  if (state === undefined || state === null || state === '')
    return { action: 'fail', why: 'the build carries no processing state' };
  if (BUILD_TERMINAL_BAD.has(state))
    return { action: 'fail', why: `Apple rejected the build during processing (${state})` };
  // An unknown state is NOT a reason to keep polling: a new Apple state that happens to be terminal
  // would hold the runner until the job timed out, and the log would say nothing.
  return { action: 'fail', why: `unknown build processing state ${state}` };
}

/**
 * What to do about an existing App Store version that already carries this version string.
 *
 * @param {string | undefined} state
 * @returns {{action: 'edit'} | {action: 'done', why: string} | {action: 'fail', why: string}}
 */
export function classifyVersionState(state) {
  if (state && VERSION_EDITABLE.has(state)) return { action: 'edit' };
  if (state && VERSION_IN_REVIEW.has(state))
    return { action: 'done', why: `it is already with Apple (${state})` };
  if (state && VERSION_DONE.has(state))
    return { action: 'done', why: `it is already released or releasing (${state})` };
  if (!state) return { action: 'fail', why: 'the version carries no state' };
  return { action: 'fail', why: `unknown version state ${state}` };
}

/**
 * The release notes for exactly this version.
 *
 * APPLE REQUIRES THEM and refuses the submission without them, so their absence has to be a
 * refusal somewhere. Being refused by Apple at the END of a release - after the bump, the deploy,
 * the Play publish and a twenty-minute macOS build - is the shape this project spends its gates
 * avoiding, which is why `release-preflight.sh` calls this same function through `--check-notes`
 * before anything moves.
 *
 * THE FILE NAMES ITS OWN VERSION, and that is the whole point of the first line. A notes file
 * without one would pass an "is it non-empty" check for ever while describing the release before
 * last, and the store would carry notes for the wrong version - a staleness nothing could detect,
 * because a file cannot be asked when it was last meant. Naming the version makes it impossible
 * instead of reported: the notes either say 0.16.0 or the release does not start.
 *
 * @param {{file: string, version: string}} arg
 * @returns {{ok: true, text: string} | {ok: false, why: string}}
 */
export function readWhatsNew({ file, version }) {
  if (!existsSync(file))
    return {
      ok: false,
      why:
        `${file} does not exist. Apple requires release notes on every version and refuses the ` +
        `submission without them. Write them, first line "version: ${version}".`,
    };

  const raw = readFileSync(file, 'utf8');
  // CRLF-TOLERANT SPLIT, because this file is edited on the workstation, which is Windows: a stray
  // carriage return left on the marker line would otherwise read as a version mismatch against the
  // very version it names, and the message would then compare two strings that look identical.
  const lines = raw.split(/\r?\n/);
  const marker = /^version:\s*(\S+)\s*$/.exec(lines[0] ?? '');
  if (!marker)
    return {
      ok: false,
      why:
        `${file} must open with "version: ${version}" so it cannot silently describe an earlier ` +
        `release; its first line is ${JSON.stringify(lines[0] ?? '')}`,
    };
  if (marker[1] !== version)
    return {
      ok: false,
      why:
        `${file} carries notes for ${marker[1]}, and this release is ${version}. Rewrite them for ` +
        `${version} - the store would otherwise publish the previous version's notes.`,
    };

  const text = lines.slice(1).join('\n').trim();
  if (!text) return { ok: false, why: `${file} names ${version} but carries no notes under it` };
  if (text.length > WHATS_NEW_MAX)
    return {
      ok: false,
      why: `${file} holds ${text.length} characters of notes; Apple's limit is ${WHATS_NEW_MAX}`,
    };
  return { ok: true, text };
}

// -------------------------------------------------------------------------------------------------
// The API
// -------------------------------------------------------------------------------------------------

/** @type {(token: string) => (method: string, path: string, body?: unknown) => Promise<any>} */
const client = (token) => async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Apple answers HTML for some gateway errors; the status and the body are what a reader needs.
  }
  if (!res.ok) {
    // THE ERROR DETAIL IS THE WHOLE VALUE OF THIS BRANCH. Apple's errors say exactly what is wrong
    // ("You must provide a value for 'whatsNew'"), and a bare status turns that into a guess.
    const detail =
      json?.errors?.map((e) => `${e.title}: ${e.detail ?? ''}`).join(' | ') ?? text.slice(0, 400);
    throw new Error(`${method} ${path} -> ${res.status} ${detail}`);
  }
  return json;
};

const log = (msg) => process.stdout.write(`${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const need = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };

  // ONE IMPLEMENTATION OF THE NOTES RULE, called from two places. `release-preflight.sh` runs this
  // mode before the bump, on the cheap ubuntu runner, so a missing or stale notes file refuses the
  // release in seconds instead of at the end of a twenty-minute macOS build. Re-stating the rule in
  // bash would be a second opinion about what valid notes are, and the two would drift.
  if (process.argv.includes('--check-notes')) {
    const version = need('MARKETING_VERSION');
    const file = process.env.WHATS_NEW_FILE || 'store/whats-new.txt';
    const verdict = readWhatsNew({ file, version });
    if (!verdict.ok) {
      // PLAINLY, and not through the catch below: that one prefixes "App Store submission failed",
      // which is not what happened - nothing has been submitted, and the preflight reprints this
      // line verbatim as its own refusal.
      process.stderr.write(`${verdict.why}\n`);
      process.exit(1);
    }
    log(`${file} carries ${verdict.text.length} characters of notes for ${version}`);
    return;
  }

  const keyId = need('ASC_KEY_ID');
  const issuerId = need('ASC_ISSUER_ID');
  const bundleId = need('APP_BUNDLE_ID');
  const versionString = need('MARKETING_VERSION');
  const buildNumber = need('BUILD_NUMBER');
  const whatsNewFile = process.env.WHATS_NEW_FILE || 'store/whats-new.txt';
  const dryRun = process.env.DRY_RUN === '1';

  const privateKey = Buffer.from(need('ASC_API_KEY_P8'), 'base64').toString('utf8');
  const api = client(mintToken({ keyId, issuerId, privateKey }));

  log(
    `App Store submission - ${bundleId} ${versionString} (build ${buildNumber})${dryRun ? ' [DRY RUN]' : ''}`
  );

  // -- the app ------------------------------------------------------------------------------------
  const apps = await api(
    'GET',
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`
  );
  const app = apps?.data?.[0];
  if (!app) throw new Error(`no app with bundle id ${bundleId} is visible to this API key`);
  log(`  app ${app.id} - ${app.attributes?.name ?? '(unnamed)'}`);

  const notes = readWhatsNew({ file: whatsNewFile, version: versionString });
  if (!notes.ok) throw new Error(notes.why);
  log(`  release notes: ${notes.text.length} characters from ${whatsNewFile}`);

  // -- the build ----------------------------------------------------------------------------------
  // A FRESH UPLOAD IS NOT USABLE IMMEDIATELY. Apple processes it for minutes, and the build does
  // not even APPEAR in the list for the first few of them - so an absent build is a reason to wait,
  // exactly like `PROCESSING`, and only a state Apple has published is a reason to stop.
  const deadline = Date.now() + 45 * 60 * 1000;
  let build = null;
  for (let attempt = 1; ; attempt++) {
    const builds = await api(
      'GET',
      `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(buildNumber)}&limit=1`
    );
    const found = builds?.data?.[0];
    const verdict = found
      ? classifyBuildState(found.attributes?.processingState)
      : { action: 'wait' };

    if (verdict.action === 'use') {
      build = found;
      log(`  build ${found.id} is ${BUILD_READY}`);
      break;
    }
    if (verdict.action === 'fail') throw new Error(verdict.why);
    if (Date.now() > deadline)
      throw new Error(
        `build ${buildNumber} was still not ${BUILD_READY} after 45 minutes` +
          `${found ? ` (${found.attributes?.processingState})` : ' (it never appeared)'}`
      );
    log(`  waiting for build ${buildNumber} to finish processing (attempt ${attempt})`);
    await sleep(60_000);
  }

  // -- the version --------------------------------------------------------------------------------
  const existing = await api(
    'GET',
    `/v1/apps/${app.id}/appStoreVersions?filter[versionString]=${encodeURIComponent(versionString)}&limit=1`
  );
  let version = existing?.data?.[0];

  if (version) {
    const verdict = classifyVersionState(version.attributes?.appStoreState);
    if (verdict.action === 'done') {
      log(`  version ${versionString} needs nothing: ${verdict.why}`);
      log('done.');
      return;
    }
    if (verdict.action === 'fail') throw new Error(verdict.why);
    log(`  version ${versionString} exists and is editable (${version.attributes?.appStoreState})`);
  } else {
    if (dryRun) {
      log(`  [dry run] would create version ${versionString}`);
      return;
    }
    const created = await api('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: PLATFORM, versionString },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    });
    version = created.data;
    log(`  created version ${versionString} (${version.id})`);
  }

  if (dryRun) {
    log('  [dry run] would attach the build, write the release notes and submit for review');
    return;
  }

  // -- attach the build ---------------------------------------------------------------------------
  await api('PATCH', `/v1/appStoreVersions/${version.id}/relationships/build`, {
    data: { type: 'builds', id: build.id },
  });
  log(`  attached build ${buildNumber} to version ${versionString}`);

  // -- the release notes, in every locale the version has -----------------------------------------
  // WRITTEN TO EVERY LOCALIZATION, not just one. Apple requires the field per locale, and a version
  // whose second language is empty is refused with an error naming that locale and nothing else.
  {
    const locs = await api(
      'GET',
      `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`
    );
    for (const loc of locs?.data ?? []) {
      await api('PATCH', `/v1/appStoreVersionLocalizations/${loc.id}`, {
        data: {
          type: 'appStoreVersionLocalizations',
          id: loc.id,
          attributes: { whatsNew: notes.text },
        },
      });
      log(`  release notes written for ${loc.attributes?.locale}`);
    }
  }

  // -- submit -------------------------------------------------------------------------------------
  // THE MODERN FLOW, AND THE OLD ONE IS A TRAP. `POST /v1/appStoreVersionSubmissions` still exists
  // and still half-works, but Apple's review submissions replaced it: a submission is a container
  // that carries ITEMS, so one submission can hold the version, an in-app purchase and a price
  // change together. Using the old endpoint submits the version alone and leaves anything else the
  // release needed sitting unsubmitted, with no error.
  const open = await api(
    'GET',
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES&limit=1`
  );
  let submission = open?.data?.[0];
  if (submission) {
    log(`  reusing the open review submission ${submission.id} (${submission.attributes?.state})`);
  } else {
    const created = await api('POST', '/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: PLATFORM },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    });
    submission = created.data;
    log(`  created review submission ${submission.id}`);
  }

  // Adding an item that is already in the submission is an error, not a no-op, so ask first.
  const items = await api('GET', `/v1/reviewSubmissions/${submission.id}/items?limit=50`);
  const already = (items?.data ?? []).some(
    (i) => i.relationships?.appStoreVersion?.data?.id === version.id
  );
  if (already) {
    log('  the version is already an item of this submission');
  } else {
    await api('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
        },
      },
    });
    log('  added the version to the submission');
  }

  await api('PATCH', `/v1/reviewSubmissions/${submission.id}`, {
    data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
  });
  log(`  submitted ${versionString} for review`);
  log('done.');
}

// Only when run, so the decisions above can be imported by the test without reaching Apple.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('submit.mjs')) {
  main().catch((e) => {
    process.stderr.write(
      `::error::App Store submission failed - ${e instanceof Error ? e.message : String(e)}\n`
    );
    process.exit(1);
  });
}
