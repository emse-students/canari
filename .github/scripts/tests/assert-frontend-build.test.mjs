#!/usr/bin/env bun
/**
 * `assert-frontend-build.mjs` MUST REFUSE EACH DEFECT IT NAMES, AND PASS A GOOD BUILD.
 *
 * The check is what makes main's frontend build a gate (#1476/#1498: a build naming no commit, or two
 * ids, surfaced only at a release tag). A gate over a fixture nobody builds is vacuous, so each case
 * below builds a minimal artefact tree and breaks exactly one thing. `ci.yml` calling the script is
 * pinned at the end - a check no workflow calls does not exist.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProblems, ssrStartProblems } from '../assert-frontend-build.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
let failures = 0;
const ok = (what, cond) => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
};

/** A frontend dir holding a good build, with `mutate` free to break one thing in it. */
function fixture(mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'frontend-build-'));
  const put = (rel, body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  put(
    'build/client/_app/version.json',
    JSON.stringify({ version: `1791268984387-${SHA.slice(0, 9)}` })
  );
  put('build/client/_app/immutable/assets/mls_wasm_bg.B6cRKKFF.wasm', '\0asm');
  put('src/lib/proto/canari.js', '//');
  mutate(put, dir);
  return dir;
}

const run = (mutate, sha = SHA) => {
  const dir = fixture(mutate);
  try {
    return buildProblems(dir, sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

ok('a good build has no problem', run().length === 0);
ok(
  'a build that names no commit (the pre-#1476 shape, a bare timestamp) is refused',
  run((put) => put('build/client/_app/version.json', '{"version":"1791268984387"}')).some((p) =>
    p.includes('no build stamp')
  )
);
ok(
  'a build of ANOTHER commit is refused',
  run(() => {}, 'f'.repeat(40)).some((p) => p.includes('names commit'))
);
ok(
  'a build with no version.json is refused',
  run((put, dir) => rmSync(join(dir, 'build/client/_app/version.json'))).some((p) =>
    p.includes('wrote no version stamp')
  )
);
ok(
  'a build with no wasm is refused',
  run((put, dir) =>
    rmSync(join(dir, 'build/client/_app/immutable/assets/mls_wasm_bg.B6cRKKFF.wasm'))
  ).some((p) => p.includes('exactly one mls_wasm_bg'))
);
ok(
  'a build with two wasm files is refused',
  run((put) => put('build/client/_app/immutable/assets/mls_wasm_bg.OTHER.wasm', '\0asm')).some(
    (p) => p.includes('exactly one mls_wasm_bg')
  )
);
ok(
  'a missing generated protobuf module is refused',
  run((put, dir) => rmSync(join(dir, 'src/lib/proto/canari.js'))).some((p) =>
    p.includes('protobuf')
  )
);

// THE SERVER START (v1.8.2-alpha.5's dev deploy: a server chunk imported a package the SSR image
// does not ship). Each case is a tiny `build/` that node really runs, from a copy with no
// node_modules - the same conditions as the image, so a pass here is a measured one.
/** A `build/` holding `index.js` = `source`, run through `ssrStartProblems`. */
async function startProblems(source) {
  const dir = mkdtempSync(join(tmpdir(), 'ssr-fixture-'));
  try {
    writeFileSync(join(dir, 'index.js'), source);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    return await ssrStartProblems(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** adapter-node's shape: listen, print the ready line, answer `/login` with `status`. */
const server = (status, extraImport = '') => `${extraImport}
import { createServer } from 'node:http';
const s = createServer((req, res) => { res.statusCode = req.url === '/login' ? ${status} : 404; res.end(); });
s.listen({ host: process.env.HOST, port: Number(process.env.PORT) }, () => {
  console.log('Listening on http://' + process.env.HOST + ':' + s.address().port);
});
`;
ok(
  'a server that starts and answers /login with 200 passes',
  (await startProblems(server(200))).length === 0
);
{
  const problems = await startProblems(
    server(200, "import { platform } from '@tauri-apps/plugin-os';")
  );
  ok(
    "a server importing a package the image does not ship is refused, with node's ERR_MODULE_NOT_FOUND",
    problems.some((p) => p.includes('exited') && p.includes('@tauri-apps/plugin-os'))
  );
}
ok(
  'a server answering /login with 500 is refused (the image healthcheck would fail)',
  (await startProblems(server(500))).some((p) => p.includes('with 500'))
);
ok(
  'a server that exits without listening is refused',
  (await startProblems('process.exit(3);\n')).some((p) => p.includes('code 3'))
);

const ci = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workflows', 'ci.yml'),
  'utf8'
);
// The commands live in checks.sh since 2026-11-15 (`frontend-build`), shared with the local push.
const checks = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'checks.sh'),
  'utf8'
);
ok(
  'ci.yml runs the production build on push to main',
  /if: github\.event_name == 'push'[\s\S]{0,400}BUILD_SHA: \$\{\{ github\.sha \}\}\s+run: bash \.github\/scripts\/checks\.sh frontend-build "\$BUILD_SHA"/.test(
    ci
  )
);
ok(
  "ci.yml gives the build step the SSR image's node major, which the server start runs under",
  /uses: actions\/setup-node@v\d+\s+with:\s+node-version: '24'\s+- name: Build the production frontend/.test(
    ci
  )
);
ok(
  'checks.sh frontend-build builds the web bundle, then runs assert-frontend-build.mjs on it',
  /BUILD_WEB=1 bun run build\)\s+bun \.github\/scripts\/assert-frontend-build\.mjs frontend "\$sha"/.test(
    checks
  )
);

console.log(failures ? `[frontend-build] ${failures} FAILURE(S)` : '[frontend-build] clean');
process.exit(failures ? 1 : 0);
