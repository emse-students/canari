#!/usr/bin/env bun
/**
 * AN ERROR nginx MAKES ITSELF IS STILL AN ANSWER THE PHONE APPS CAN READ (2026-10-15).
 *
 * The phone apps read Canari's API through the WebView's own `fetch`, cross-origin
 * (`frontend/src/lib/utils/fetchRouting.ts`). A response without `Access-Control-Allow-Origin`
 * reaches them as a `TypeError`: a transport failure, which marks the server unreachable, where the
 * status was an answer. The services set the header on everything they answer; a 502/504 while one
 * restarts, or the 500 of a failed `auth_request`, is made by nginx and carried none.
 *
 * Asserted here, statically:
 * - the map `$api_error_cors_origin` names EXACTLY the WebView origins the services allow
 *   (`TAURI_WEBVIEW_ORIGINS`, `apps/core-service/src/cors-origins.ts`) - an allowlist that drifts
 *   from the services' is a platform whose errors read as "offline";
 * - the server block sends 413, 429, 500, 502, 503 and 504 to `@api_error_<code>`, each of which includes the
 *   header snippet and answers its own code;
 * - the snippet sends the mapped origin, `Vary: Origin` and the three security headers.
 */
import { readFileSync } from 'node:fs';

const DOCKERFILE = 'infrastructure/local/Dockerfile.frontend';
const CORS_ORIGINS = 'apps/core-service/src/cors-origins.ts';
const CODES = ['413', '429', '500', '502', '503', '504'];

const text = readFileSync(DOCKERFILE, 'utf8');
const failures = [];

const declared = readFileSync(CORS_ORIGINS, 'utf8').match(
  /export const TAURI_WEBVIEW_ORIGINS = \[([\s\S]*?)\]/
);
const services = new Set(declared ? [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []);
if (services.size === 0) failures.push(`no TAURI_WEBVIEW_ORIGINS found in ${CORS_ORIGINS}`);

const map = text.match(/map \$http_origin \$api_error_cors_origin \{([\s\S]*?)\n\}/);
if (!map) {
  failures.push('the map $api_error_cors_origin is gone');
} else {
  const mapped = new Set([...map[1].matchAll(/"([^"]+)" \$http_origin;/g)].map((m) => m[1]));
  const same = mapped.size === services.size && [...services].every((o) => mapped.has(o));
  if (!same) {
    failures.push(
      `the error allowlist (${[...mapped].join(', ')}) is not the services' WebView origins ` +
        `(${[...services].join(', ')})`
    );
  }
  if (!/default "";/.test(map[1])) failures.push('the map must default to "" (no header)');
}

for (const code of CODES) {
  if (!text.includes(`error_page ${code} @api_error_${code};`)) {
    failures.push(`no server-level error_page ${code} @api_error_${code}`);
  }
  const block = text.match(new RegExp(`location @api_error_${code} \\{([\\s\\S]*?)\\n\\s*\\}`));
  if (!block) {
    failures.push(`location @api_error_${code} is gone`);
    continue;
  }
  if (!block[1].includes('include /etc/nginx/snippets/api-error-headers.conf;')) {
    failures.push(`@api_error_${code} does not include the error headers`);
  }
  if (!new RegExp(`return ${code} `).test(block[1])) {
    failures.push(`@api_error_${code} does not answer ${code}`);
  }
}

const snippet = text.match(
  /RUN printf '([^']*)' > \/etc\/nginx\/snippets\/api-error-headers\.conf/
);
if (!snippet) {
  failures.push('the api-error-headers.conf snippet is not written');
} else {
  for (const needle of [
    'Access-Control-Allow-Origin $api_error_cors_origin always',
    'Vary "Origin" always',
    'snippets/csp.conf',
    'X-Content-Type-Options',
    'X-Frame-Options',
  ]) {
    if (!snippet[1].includes(needle)) failures.push(`the error headers lack ${needle}`);
  }
}

if (failures.length > 0) {
  console.error(`api-error-cors: ${failures.length} failure(s)\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `api-error-cors: nginx's own ${CODES.join('/')} answer the ${services.size} WebView origins`
);
