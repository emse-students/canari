#!/usr/bin/env bun
/**
 * THE NGINX ACCESS LOG NEVER RECORDS A BEARER TOKEN.
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
 * - no location overrides it with another format.
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
const accessLogs = lines.filter((l) => /^access_log\s/.test(l));

if (logFormats.length !== 1) fail(`expected exactly one log_format, found ${logFormats.length}`);
const format = logFormats[0] ?? '';
const formatName = format.match(/^log_format\s+(\S+)/)?.[1] ?? '';
if (/\$request(?![_\w])/.test(format) || /\$request_uri/.test(format)) {
  fail('the log format prints $request or $request_uri raw - the token would be logged');
}
if (!/\$logged_request_uri/.test(format)) fail('the log format does not print $logged_request_uri');
if (formatName === 'main') fail('the format is named `main`, a duplicate of the base image');

const map = lines.join('\n').match(/map \$request_uri \$logged_request_uri \{([\s\S]*?)\n\}/)?.[1];
if (!map) fail('the `map $request_uri $logged_request_uri` redaction is missing');
else {
  const rule = map.match(/"(~\^.*)"\s+"([^"]*)";/);
  if (!rule) fail('the map has no regex rule');
  else {
    // The same regex, run here on the cases that mattered (nginx's PCRE and JS agree on this one).
    const re = new RegExp(rule[1].slice(1).replace(/\(\?<(\w+)>/g, '(?<$1>'));
    const apply = (uri) => {
      const m = uri.match(re);
      return m ? `${m.groups.uri_before_token}token=redacted${m.groups.uri_after_token}` : uri;
    };
    const cases = [
      [
        '/api/ws?userId=u1&token=eyJSECRET.abc&deviceId=d1',
        '/api/ws?userId=u1&token=redacted&deviceId=d1',
      ],
      ['/api/ws?token=eyJSECRET', '/api/ws?token=redacted'],
      ['/x?xtoken=keep&a=b', '/x?xtoken=keep&a=b'],
      ['/plain', '/plain'],
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
const accessAt = lines.findIndex((l) => /^access_log\s/.test(l));
const firstLocation = lines.findIndex((l) => /^location\s/.test(l));
if (serverAt === -1 || accessAt < serverAt || accessAt > firstLocation) {
  fail('the access_log is not declared in the server block before its locations');
}

if (failures.length > 0) {
  console.error(`access-log-redaction: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('access-log-redaction: the access log cannot record a token');
