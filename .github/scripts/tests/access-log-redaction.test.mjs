#!/usr/bin/env bun
/**
 * THE NGINX ACCESS LOG NEVER RECORDS A BEARER TOKEN, NOR A GIF SEARCH.
 *
 * Production, 2026-10-06: every `GET /api/ws?...&token=<JWT>` line of the container's access log
 * carried a live access token (1 h). The client sends it in the query on purpose (Tauri and proxies
 * that drop the `canari_ws_token` cookie), so the fix is in what is WRITTEN, not in the request.
 * The shape that keeps it fixed:
 *
 * - the log format never prints `$request` or `$request_uri` raw, only `$logged_request_uri`, the
 *   `map` that redacts every `token=` query value;
 * - the server block declares the `access_log` ITSELF: one declared at http level would ADD to the
 *   base image's `main` and leave the unredacted line beside the redacted one;
 * - no location overrides it with another format (`access_log off;` is allowed: it records nothing);
 * - a `/api/mls/gifs` line drops its whole query: the route exists so a search is never tied to the
 *   reader's address, and this line carries the address. The GIF relay (`/api/mls/gifs/media`) keeps
 *   its own path and drops its query too: it names which GIF the reader loaded.
 * - a guest receipt page (`/f/<id>/receipt?receipt=`) drops its query: the receipt is a paying
 *   guest's only proof of the answer (paid public forms WP-P2).
 * - a legacy presence read (`/api/presence?users=`) drops its query: it names every user a member
 *   watches, and its length tripped a log scanner (2026-10-28). Current clients POST the ids.
 *
 * STATIC (CI has no Docker daemon); the behaviour was run against nginx:stable-alpine on 2026-10-06
 * with five request lines, one log line each, the token redacted and `xtoken=` left alone.
 *
 * Usage: bun .github/scripts/tests/access-log-redaction.test.mjs [repo-root]
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const nginx = readFileSync(join(ROOT, 'infrastructure', 'local', 'Dockerfile.frontend'), 'utf8');
const failures = [];
const fail = (msg) => failures.push(msg);

// One directive per line, Dockerfile continuation and comments dropped.
const lines = nginx
  .split('\n')
  .map((l) => l.replace(/\\n\\$/, '').trim())
  .filter((l) => !l.startsWith('#'));

const logFormats = lines.filter((l) => /^log_format\s/.test(l));
// `access_log off;` in a location writes nothing, so it cannot leak a token (the health probe uses
// it: a line every 30 s per replica would be noise). Any other access_log, a second format, still
// counts and is refused.
const accessLogs = lines.filter((l) => /^access_log\s/.test(l) && !/^access_log\s+off\s*;$/.test(l));

if (logFormats.length !== 1) fail(`expected exactly one log_format, found ${logFormats.length}`);
const format = logFormats[0] ?? '';
const formatName = format.match(/^log_format\s+(\S+)/)?.[1] ?? '';
if (/\$request(?![_\w])/.test(format) || /\$request_uri/.test(format)) {
  fail('the log format prints $request or $request_uri raw - the token would be logged');
}
if (!/\$logged_request_uri/.test(format)) fail('the log format does not print $logged_request_uri');
// The diagnostic tail (2026-10-18): what lets one line say why a preview was slow, compressed or
// degraded. Asserted PRESENT, and the format asserted free of the two request headers that would
// turn a duration field into a credential leak.
for (const field of [
  'rt=$request_time',
  'urt=$upstream_response_time',
  'ust=$upstream_status',
  'ce=$sent_http_content_encoding',
  'deg=$sent_http_x_canari_degraded',
]) {
  if (!format.includes(field)) fail(`the log format lacks the diagnostic field ${field}`);
}
if (/\$http_(cookie|authorization)|\$cookie_/.test(format)) {
  fail('the log format prints a cookie or an authorization header');
}
if (formatName === 'main') fail('the format is named `main`, a duplicate of the base image');

const map = lines.join('\n').match(/map \$request_uri \$logged_request_uri \{([\s\S]*?)\n\}/)?.[1];
if (!map) fail('the `map $request_uri $logged_request_uri` redaction is missing');
else {
  const rules = [...map.matchAll(/"(~\^[^"]*)"\s+"([^"]*)";/g)].map((m) => ({
    re: new RegExp(m[1].slice(1).replace(/\(\?<(\w+)>/g, '(?<$1>')),
    value: m[2],
  }));
  if (rules.length === 0) fail('the map has no regex rule');
  else {
    // The map's own rules, run here in ITS order (first match wins, as in nginx; nginx's PCRE and
    // JS agree on these). A value naming captures is expanded from them.
    const apply = (uri) => {
      for (const { re, value } of rules) {
        const m = uri.match(re);
        if (m) return value.replace(/\$\{(\w+)\}/g, (_, g) => m.groups?.[g] ?? '');
      }
      return uri;
    };
    const cases = [
      [
        '/api/ws?userId=u1&token=eyJSECRET.abc&deviceId=d1',
        '/api/ws?userId=u1&token=redacted&deviceId=d1',
      ],
      ['/api/ws?token=eyJSECRET', '/api/ws?token=redacted'],
      ['/x?xtoken=keep&a=b', '/x?xtoken=keep&a=b'],
      ['/plain', '/plain'],
      // A GIF search: the whole query goes, whatever it carries (2026-10-16).
      ['/api/mls/gifs?q=chat%20noir&page=2', '/api/mls/gifs?query-redacted'],
      ['/api/mls/gifs?page=1&q=x&token=eyJSECRET', '/api/mls/gifs?query-redacted'],
      ['/api/mls/gifsy?q=keep', '/api/mls/gifsy?q=keep'],
      // The GIF relay: which GIF, beside the reader's address, is not logged either (2026-10-18).
      [
        '/api/mls/gifs/media?url=https%3A%2F%2Fstatic.klipy.com%2Fii%2Fa%2Fb.gif&t=abc',
        '/api/mls/gifs/media?query-redacted',
      ],
      // A paying guest's receipt, its only proof of the answer (2026-10-22): the query goes.
      ['/f/abc-123/receipt?receipt=Q2FuYXJpU0VDUkVUcmVjZWlwdA', '/f/abc-123/receipt?query-redacted'],
      ['/f/abc-123/receipt?x=1&receipt=SECRET', '/f/abc-123/receipt?query-redacted'],
      ['/f/abc-123/receipt', '/f/abc-123/receipt'],
      ['/f/abc-123?receipt=keep', '/f/abc-123?receipt=keep'],
      // The legacy presence read names every watched user (2026-10-28): the query goes.
      [`/api/presence?users=${'a'.repeat(64)},${'b'.repeat(64)}`, '/api/presence?query-redacted'],
      ['/api/presence', '/api/presence'],
      ['/api/admin/presence', '/api/admin/presence'],
      ['/api/presences?users=keep', '/api/presences?users=keep'],
    ];
    for (const [input, expected] of cases) {
      if (apply(input) !== expected) fail(`${input} logs as ${apply(input)}, expected ${expected}`);
    }
  }
}

if (accessLogs.length !== 1) {
  fail(`expected exactly one access_log (server level), found ${accessLogs.length}`);
} else if (!accessLogs[0].endsWith(` ${formatName};`)) {
  fail(`the access_log does not use the redacting format: ${accessLogs[0]}`);
}
const serverAt = lines.findIndex((l) => l === 'server {');
const accessAt = lines.findIndex((l) => /^access_log\s/.test(l) && !/^access_log\s+off\s*;$/.test(l));
const firstLocation = lines.findIndex((l) => /^location\s/.test(l));
if (serverAt === -1 || accessAt < serverAt || accessAt > firstLocation) {
  fail('the access_log is not declared in the server block before its locations');
}

if (failures.length > 0) {
  console.error(`access-log-redaction: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(
  'access-log-redaction: the access log cannot record a token, a GIF search, a guest receipt, nor presence ids'
);
