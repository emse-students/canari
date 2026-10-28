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
 * - a URL carrying a capability (2026-10-28): the link previews and the link check drop their
 *   query, the OIDC callback its query, an invite route keeps its path with the token replaced -
 *   and a join path quoted percent-encoded in a query too. The `token` key spelled twice,
 *   percent-encoded, in another case or as an array drops the whole query (a map rewrites ONE
 *   occurrence). The route map and the token map are chained, so both apply to one line.
 * - the referer field goes through its own map: one naming any of those keeps its origin only.
 *
 * Every rule has a case that must be redacted and a near-miss that must stay readable.
 *
 * STATIC (CI has no Docker daemon); the behaviour was run against nginx:stable-alpine on 2026-10-06
 * with five request lines, one log line each, the token redacted and `xtoken=` left alone; and again
 * on 2026-10-28 with the built image, the capability routes and referers below: no secret in the log.
 *
 * Usage: bun .github/scripts/tests/access-log-redaction.test.mjs [repo-root]
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const nginx = readFileSync(join(ROOT, 'infrastructure', 'local', 'Dockerfile.frontend'), 'utf8');
const failures = [];
const fail = (msg) => failures.push(msg);

// One directive per line, Dockerfile continuation and comments dropped. The config is written by
// `printf`, so a literal percent sign is spelled `%%` in the Dockerfile and read back as one here.
const lines = nginx
  .split('\n')
  .map((l) =>
    l
      .replace(/\\n\\$/, '')
      .replace(/%%/g, '%')
      .trim()
  )
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

/**
 * A `map <source> <target>` block, compiled to a function: its regex rules run in ITS order (first
 * match wins, as in nginx; nginx's PCRE and JS agree on these), `~*` is case-insensitive, a value
 * naming captures is expanded from them, and a default naming the source variable is the input
 * unchanged. Returns null when the block is missing or has no regex rule.
 */
const compileMap = (source, target) => {
  const body = lines
    .join('\n')
    .match(new RegExp(`map \\$${source} \\$${target} \\{([\\s\\S]*?)\\n\\}`))?.[1];
  if (!body) return null;
  const rules = [...body.matchAll(/"(~\*?)\^([^"]*)"\s+"([^"]*)";/g)].map((m) => ({
    re: new RegExp(`^${m[2]}`, m[1] === '~*' ? 'i' : ''),
    value: m[3],
  }));
  // An exact key wins over every regex in nginx, whatever its position.
  const exact = new Map(
    [...body.matchAll(/^\s*"([^~"][^"]*|)"\s+"([^"]*)";/gm)].map((m) => [m[1], m[2]])
  );
  if (rules.length === 0) return null;
  if (!new RegExp(`default \\$${source};`).test(body)) return null;
  return (input) => {
    if (exact.has(input)) return exact.get(input);
    for (const { re, value } of rules) {
      const m = input.match(re);
      if (m) return value.replace(/\$\{(\w+)\}/g, (_, g) => m.groups?.[g] ?? '');
    }
    return input;
  };
};

// The format prints the referer only through its redacting map.
if (/\$http_referer/.test(format)) fail('the log format prints $http_referer raw');
if (!/\$logged_http_referer/.test(format))
  fail('the log format does not print $logged_http_referer');

// Two maps, chained: the route rules, then the token rules on their output.
const routeMap = compileMap('request_uri', 'route_redacted_request_uri');
const tokenMap = compileMap('route_redacted_request_uri', 'logged_request_uri');
const refererMap = compileMap('http_referer', 'logged_http_referer');
if (!routeMap) fail('the `map $request_uri $route_redacted_request_uri` redaction is missing');
if (!tokenMap) fail('the `map $route_redacted_request_uri $logged_request_uri` is missing');
if (!refererMap) fail('the `map $http_referer $logged_http_referer` redaction is missing');
if (routeMap && tokenMap && refererMap) {
  {
    const apply = (uri) => tokenMap(routeMap(uri));
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
      [
        '/f/abc-123/receipt?receipt=Q2FuYXJpU0VDUkVUcmVjZWlwdA',
        '/f/abc-123/receipt?query-redacted',
      ],
      ['/f/abc-123/receipt?x=1&receipt=SECRET', '/f/abc-123/receipt?query-redacted'],
      ['/f/abc-123/receipt', '/f/abc-123/receipt'],
      ['/f/abc-123?receipt=keep', '/f/abc-123?receipt=keep'],
      // The token key, however it is spelled (2026-10-28): twice, percent-encoded, another case,
      // an array. Each loses its whole query; `xtoken` and a value that merely says token stay.
      ['/api/ws?token=A&x=1&token=B', '/api/ws?query-redacted'],
      ['/api/ws?%74oken=SECRET&a=b', '/api/ws?query-redacted'],
      ['/api/ws?a=b&%74%6F%6B%65%6E=SECRET', '/api/ws?query-redacted'],
      ['/api/ws?TOKEN=SECRET', '/api/ws?TOKEN=redacted'],
      ['/api/ws?token[]=SECRET', '/api/ws?query-redacted'],
      ['/api/ws?token%5B%5D=SECRET', '/api/ws?query-redacted'],
      ['/x?xtoken=a&ytoken=b', '/x?xtoken=a&ytoken=b'],
      ['/x?%78token=keep', '/x?%78token=keep'],
      ['/x?q=token%3Dkeep', '/x?q=token%3Dkeep'],
      ['/x?tokens=keep', '/x?tokens=keep'],
      // The link previews and the link check: which URL a reader opened (2026-10-28).
      [
        '/api/mls/link-preview?url=https%3A%2F%2Fa.example%2Fp',
        '/api/mls/link-preview?query-redacted',
      ],
      [
        '/api/mls/link-preview/image?url=https%3A%2F%2Fa.example%2Fi.png&t=tkt',
        '/api/mls/link-preview/image?query-redacted',
      ],
      ['/api/mls/link-safety?url=https%3A%2F%2Fa.example', '/api/mls/link-safety?query-redacted'],
      ['/api/mls/link-previews?url=keep', '/api/mls/link-previews?url=keep'],
      ['/api/mls/link-preview', '/api/mls/link-preview'],
      // The OIDC callback's one-time code (2026-10-28).
      ['/auth/callback?code=SECRET&state=S', '/auth/callback?query-redacted'],
      ['/auth/callbacks?code=keep', '/auth/callbacks?code=keep'],
      ['/auth/login?code=keep', '/auth/login?code=keep'],
      // An invite token in a path, and quoted in a login returnTo (2026-10-28).
      ['/c/join/INVITE-SECRET', '/c/join/redacted'],
      ['/g/join/INVITE-SECRET', '/g/join/redacted'],
      ['/c/join/INVITE-SECRET?token=JWT', '/c/join/redacted?token=redacted'],
      ['/login?returnTo=%2Fc%2Fjoin%2FINVITE-SECRET', '/login?returnTo=%2Fc%2Fjoin%2Fredacted'],
      ['/login?returnTo=%2fg%2fjoin%2fINVITE-SECRET', '/login?returnTo=%2fg%2fjoin%2fredacted'],
      ['/api/channels/invites/INVITE-SECRET', '/api/channels/invites/redacted'],
      ['/api/channels/invites/INVITE-SECRET/accept', '/api/channels/invites/redacted/accept'],
      ['/api/mls/group-invites/INVITE-SECRET', '/api/mls/group-invites/redacted'],
      ['/api/mls/group-invites/INVITE-SECRET/accept', '/api/mls/group-invites/redacted/accept'],
      ['/c/joinx/keep', '/c/joinx/keep'],
      ['/c/join/', '/c/join/'],
      ['/abc/join/keep', '/abc/join/keep'],
      ['/login?returnTo=%2Fchat', '/login?returnTo=%2Fchat'],
      ['/api/channels/invites', '/api/channels/invites'],
      ['/api/channels/abc/invites', '/api/channels/abc/invites'],
      ['/api/mls/group-invitesx/keep', '/api/mls/group-invitesx/keep'],
    ];
    for (const [input, expected] of cases) {
      if (apply(input) !== expected) fail(`${input} logs as ${apply(input)}, expected ${expected}`);
    }
  }
  // The referer of a capability page keeps its origin only (2026-10-28); every other is unchanged.
  const referers = [
    ['https://canari.emse.fr/c/join/INVITE-SECRET', 'https://canari.emse.fr/redacted'],
    ['https://canari.emse.fr/g/join/INVITE-SECRET', 'https://canari.emse.fr/redacted'],
    [
      'https://canari.emse.fr/login?returnTo=%2Fc%2Fjoin%2FSECRET',
      'https://canari.emse.fr/redacted',
    ],
    ['https://canari.emse.fr/f/abc/receipt?receipt=SECRET', 'https://canari.emse.fr/redacted'],
    ['https://canari.emse.fr/auth/callback?code=SECRET', 'https://canari.emse.fr/redacted'],
    ['https://canari.emse.fr/x?a=1&%74oken=SECRET', 'https://canari.emse.fr/redacted'],
    ['https://canari.emse.fr/api/ws?token=SECRET', 'https://canari.emse.fr/redacted'],
    ['https://canari.emse.fr/chat', 'https://canari.emse.fr/chat'],
    ['https://canari.emse.fr/c/joinx/keep', 'https://canari.emse.fr/c/joinx/keep'],
    ['https://canari.emse.fr/f/abc/receipt', 'https://canari.emse.fr/f/abc/receipt'],
    ['https://canari.emse.fr/f/abc?receipt=keep', 'https://canari.emse.fr/f/abc?receipt=keep'],
    ['https://canari.emse.fr/x?xtoken=keep', 'https://canari.emse.fr/x?xtoken=keep'],
    ['https://www.google.com/', 'https://www.google.com/'],
    ['-', '-'],
    // No Referer at all: the stock "-", not the "" a map's empty value would write.
    ['', '-'],
  ];
  for (const [input, expected] of referers) {
    const got = refererMap(input);
    if (got !== expected) fail(`referer ${input} logs as ${got}, expected ${expected}`);
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
  'access-log-redaction: the access log cannot record a token, a GIF search, a guest receipt, ' +
    'a link a reader opened, an OIDC code nor an invite, in the request line or the referer'
);
