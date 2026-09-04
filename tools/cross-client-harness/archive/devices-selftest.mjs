#!/usr/bin/env node
/**
 * SELFTEST FOR THE DEVICE CENSUS - pins the classification against rows measured on production.
 *
 *   bun devices-selftest.mjs
 *
 * WHY A CENSUS NEEDS A SELFTEST AT ALL. This tool's whole output is a count, and a count is the one
 * kind of answer that looks equally confident when it is wrong. Its push predicate was written
 * wrong TWICE before it was measured - once trusting `deviceOs` alone (135 phantom defects: every
 * browser on a phone), once trusting the id prefix alone (which cannot tell Android from the desktop
 * AppImage) - and its stranded-user count was wrong a third time by folding in devices that are
 * routed nowhere (95 reported, 9 real). None of those three failures throws, logs, or looks odd.
 * Only a fixture that already knows the answer catches them.
 *
 * EVERY CASE BELOW IS A REAL SHAPE SEEN ON PRODUCTION on 2026-08-24, with the ids replaced. The
 * point is not to test string splitting: it is to keep the three corrections above from being
 * quietly undone by a later edit that "simplifies" the predicate back to one column.
 */
import { daysBetween, installTag, parseRow, runtimeOf, summarize, userTag } from '../device-census.mjs';

const TODAY = '2026-08-24';
let failures = 0;

/** One assertion, named by what it protects rather than by what it compares. */
function check(what, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${what}\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok    ${what}`);
  }
}

/**
 * Builds a census line from named parts, so a case reads as the device it describes.
 * Field order mirrors `CENSUS_SQL`'s SELECT list exactly.
 */
function row({
  deviceId,
  userId = 'u-1',
  os = '',
  ver = '',
  name = '',
  kp = 1,
  active = 0,
  all = 0,
  push = '',
  first = '2026-08-01',
  last = '2026-08-01',
  tokenSeen = '',
}) {
  return [deviceId, userId, os, ver, name, kp, active, all, push, first, last, tokenSeen].join('|');
}

// --- the runtime prefix, including the shape that has no prefix at all --------------------------
check('tauri prefix is the native runtime', runtimeOf('tauri-u-1-mq6xoj9k-b6wr'), 'tauri');
check('web prefix is the browser runtime', runtimeOf('web-u-1-mq6xoj9k-b6wr'), 'web');
// MEASURED ON PROD: two ids match neither prefix. Reading them as `web` would assert a runtime
// nobody recorded, and would then decide push expectations from that invention.
//
// NO RUN OF FOUR DIGITS IN A FIXTURE ID. `idcheck.mjs` matches the real test-account secrets
// literally and word-bounded, and one of those PINs is four digits: the first draft of this fixture
// spelled a four-digit run and was refused at the gate. The collision was a coincidence, but the gate is
// right to be literal, so the fixtures avoid digit runs instead of the gate being loosened. This
// note deliberately does not quote the offending string either - the first version of it did, and
// tripped the same gate on the comment.
check('an id predating the prefix scheme is legacy, not web', runtimeOf('8969fe8c-a1b2-c3d4'), 'legacy');

// --- THE PUSH PREDICATE, IN BOTH DIRECTIONS IT WAS ONCE WRONG ----------------------------------
// Safari on an iPhone self-reports `deviceOs: ios`. 73 such devices exist on prod, none of which
// can hold an FCM token. Trusting the OS alone called every one of them a defect.
check(
  'a browser on an iPhone expects no push despite an ios OS',
  parseRow(row({ deviceId: 'web-u-1-abc-de', os: 'ios', active: 1, all: 1 }), TODAY).pushExpected,
  false
);
check(
  'a browser on an Android expects no push despite an android OS',
  parseRow(row({ deviceId: 'web-u-1-abc-de', os: 'android', active: 1, all: 1 }), TODAY).pushExpected,
  false
);
// And the other direction: `tauri` covers the desktop AppImage, which never registers by design.
check(
  'the desktop AppImage expects no push despite a native runtime',
  parseRow(row({ deviceId: 'tauri-u-1-abc-de', os: 'linux', active: 1, all: 1 }), TODAY).pushExpected,
  false
);
check(
  'a native Android is the one shape push is expected from',
  parseRow(row({ deviceId: 'tauri-u-1-abc-de', os: 'android', active: 1, all: 1 }), TODAY).pushExpected,
  true
);
// A legacy id is never counted as a defect: its runtime is unknown, so nothing is expected of it.
check(
  'a legacy id expects no push even on a mobile OS',
  parseRow(row({ deviceId: '8969fe8c-a1b2', os: 'android', active: 1, all: 1 }), TODAY).pushExpected,
  false
);

// --- UNPUSHABLE NEEDS THE ROUTING HALF TOO -----------------------------------------------------
// The finding is "a push had nowhere to go", which cannot happen to a device nothing sends to.
check(
  'a native Android in no active group is not a reachability defect',
  parseRow(row({ deviceId: 'tauri-u-1-abc-de', os: 'android', active: 0, all: 0 }), TODAY).unpushable,
  false
);
check(
  'a routed native Android with no token IS the defect',
  parseRow(row({ deviceId: 'tauri-u-1-abc-de', os: 'android', active: 1, all: 1 }), TODAY).unpushable,
  true
);
check(
  'a routed native Android WITH a token is fine',
  parseRow(
    row({ deviceId: 'tauri-u-1-abc-de', os: 'android', active: 1, all: 1, push: 'android' }),
    TODAY
  ).unpushable,
  false
);
// `status` matters: a device whose only membership is inactive is routed nowhere. The SQL already
// splits active from all, and this pins that the classification reads the ACTIVE count.
check(
  'a device whose memberships are all inactive is routed nowhere',
  parseRow(row({ deviceId: 'tauri-u-1-abc-de', os: 'android', active: 0, all: 3 }), TODAY).routed,
  false
);

// --- THE STRANDED COUNT, WHICH ONCE OVERSTATED ITSELF BY 10x -----------------------------------
// Nine of eighteen routed owners had no reachable device; the first draft said ninety-five, by
// counting owners whose only devices were unrouted first-launch enrolments.
{
  const rows = [
    // Owner A: one routed phone, no token -> genuinely stranded.
    parseRow(row({ deviceId: 'tauri-a-1-x', userId: 'a', os: 'android', active: 1, all: 1 }), TODAY),
    // Owner B: a routed phone that works, plus an abandoned install -> NOT stranded, but the dead
    // install is still an unpushable routed device and must be counted as one.
    parseRow(
      row({ deviceId: 'tauri-b-1-x', userId: 'b', os: 'android', active: 1, all: 1, push: 'android' }),
      TODAY
    ),
    parseRow(row({ deviceId: 'tauri-b-2-y', userId: 'b', os: 'android', active: 1, all: 1 }), TODAY),
    // Owner C: enrolled once, never joined anything -> invisible to the stranded count entirely.
    parseRow(row({ deviceId: 'tauri-c-1-x', userId: 'c', os: 'android', active: 0, all: 0 }), TODAY),
    // A browser, which the count must ignore on both sides.
    parseRow(row({ deviceId: 'web-d-1-x', userId: 'd', os: 'ios', active: 1, all: 1 }), TODAY),
  ];
  const s = summarize(rows);
  check('stranded counts only owners routed to with nothing reachable', s.strandedUsers, 1);
  check('routed owners exclude the unrouted and the browsers', s.routedUsers, 2);
  check('unpushable counts the abandoned install as well as the stranded one', s.unpushable, 2);
  check('an enrolled-but-unrouted native device is reported apart', s.enrolledUnrouted, 1);
  check('every device is still in the total', s.devices, 5);
}

// --- REDACTION, WHICH IS A SECURITY PROPERTY AND NOT A DISPLAY CHOICE --------------------------
// The device id EMBEDS the user id, so the install tag must keep only the trailing two segments.
check('the install tag drops the embedded user id', installTag('tauri-abcd-efgh-mq6xoj9k-b6wr'), 'mq6xoj9k-b6wr');
check('the user tag is stable', userTag('u-1'), userTag('u-1'));
check('the user tag separates two owners', userTag('u-1') === userTag('u-2'), false);
check('the user tag reveals no input', userTag('u-1').includes('u-1'), false);

// --- SCHEMA DRIFT MUST BE LOUD, NOT SILENT ------------------------------------------------------
// A column added to the SELECT list shifts every field after it. Parsing on regardless would
// misreport the whole estate with total confidence, so the row count is asserted per line.
{
  let threw = false;
  try {
    parseRow('too|few|fields', TODAY);
  } catch {
    threw = true;
  }
  check('a row with the wrong field count throws', threw, true);
}

// --- DERIVED IDLE TIME IS REPRODUCIBLE ----------------------------------------------------------
// The reference date is injected, never read from the clock: the campaign's standing rule.
check('idle days are computed from the injected date', daysBetween('2026-07-25', TODAY), 30);
check(
  'a device never described has no idle time rather than a wrong one',
  parseRow(row({ deviceId: 'tauri-u-1-x', os: 'android', last: '' }), TODAY).staleDays,
  null
);

console.log(
  failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
