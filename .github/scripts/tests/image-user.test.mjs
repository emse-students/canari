#!/usr/bin/env bun
/**
 * EVERY SERVICE IMAGE RUNS AS A NON-ROOT USER, UNLESS IT IS NAMED BELOW WITH ITS REASON.
 *
 * Trivy's Dockerfile scan (DS-0002) found no `USER` in any `infrastructure/local/Dockerfile.*` on
 * 2026-10-23 ([cicd](../../../docs/wiki/cicd.md#container-images-are-scanned-2026-10-23)). Six of the
 * eight were measured on 2026-11-11 to need nothing root gives: no volume in either deployed compose
 * file, no write to disk, a port above 1024. They now carry a `USER`, and this test keeps it so:
 *
 * - the FINAL stage's last `USER` is not root (a `USER` in a builder stage protects nothing);
 * - an image left as root is in `ROOT_ALLOWED` with the reason it cannot move yet, and an entry
 *   whose image gained a non-root `USER` FAILS until it is deleted (the list only shrinks);
 * - no deployed compose file hands a service back to root with `user:`;
 * - every `apt-get install` carries `--no-install-recommends` (DS-0029).
 *
 * Run by `make test-ci-scripts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const LOCAL = join(ROOT, 'infrastructure', 'local');

/**
 * The images still root, and why. Each reason is the thing that must change first - see the backlog
 * fragment `p3-two-service-images-still-run-as-root.md`.
 */
const ROOT_ALLOWED = {
  'Dockerfile.frontend':
    'nginx binds port 80 and writes its cache and pid under root-owned paths; moving it means a port above 1024 across the edge, both compose files and the rotation',
  'Dockerfile.media-service':
    'its three named volumes (media_meta, live_segments, upload_sessions) hold files written by root on both estates; a USER needs them re-owned on each estate first',
};

const COMPOSE_FILES = [
  'infrastructure/docker-compose.prod.yml',
  'infrastructure/docker-compose.dev.yml',
];

let failures = 0;
let checks = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const ok = (msg) => {
  checks++;
  console.log(`  ok    ${msg}`);
};

/** Instruction lines with their continuations joined, comments dropped. */
function instructions(text) {
  return text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** The user the final stage runs as: its last `USER`, or `null` when it has none (root). */
export function finalStageUser(text) {
  const lines = instructions(text);
  let lastFrom = -1;
  lines.forEach((l, i) => {
    if (/^FROM\s/i.test(l)) lastFrom = i;
  });
  let user = null;
  for (const l of lines.slice(lastFrom + 1)) {
    const m = /^USER\s+(\S+)/i.exec(l);
    if (m) user = m[1];
  }
  return user;
}

/** Whether a `USER` value names root. */
export const isRoot = (user) => user === null || /^(root|0)(:.*)?$/.test(user);

/** The `apt-get install` instructions missing `--no-install-recommends`. */
export function installsWithRecommends(text) {
  return instructions(text).filter(
    (l) => /apt-get\s+install/.test(l) && !/--no-install-recommends/.test(l)
  );
}

console.log('\nthe checker itself');
{
  const builderOnly = 'FROM a AS b\nUSER bun\nRUN x\nFROM c\nCMD ["y"]\n';
  if (isRoot(finalStageUser(builderOnly))) ok('a USER in a builder stage alone reads as root');
  else fail('a USER in a builder stage was credited to the final stage');
  const backToRoot = 'FROM c\nUSER bun\nRUN x\nUSER root\nCMD ["y"]\n';
  if (isRoot(finalStageUser(backToRoot))) ok('a final USER root reads as root');
  else fail('USER root after a non-root USER was not caught');
  if (!isRoot(finalStageUser('FROM c\nUSER 65534:65534\n'))) ok('a numeric non-root USER passes');
  else fail('USER 65534:65534 read as root');
  if (installsWithRecommends('RUN apt-get update && \\\n  apt-get install -y curl\n').length === 1)
    ok('a continued apt-get install without --no-install-recommends is caught');
  else fail('a continued apt-get install line was missed');
}

console.log('\ninfrastructure/local/Dockerfile.*');
const dockerfiles = readdirSync(LOCAL).filter((f) => f.startsWith('Dockerfile.'));
if (dockerfiles.length < 8)
  fail(`only ${dockerfiles.length} Dockerfile(s) found - is this the right directory?`);
for (const file of dockerfiles) {
  const text = readFileSync(join(LOCAL, file), 'utf8');
  const user = finalStageUser(text);
  const allowed = ROOT_ALLOWED[file];
  if (isRoot(user)) {
    if (allowed) ok(`${file} is root, allowed: ${allowed.split(';')[0]}`);
    else
      fail(
        `${file} runs its final stage as root - add a non-root USER (or allowlist it with its reason)`
      );
  } else if (allowed) {
    fail(`${file} now runs as ${user}: delete it from ROOT_ALLOWED`);
  } else {
    ok(`${file} runs as ${user}`);
  }
  const bad = installsWithRecommends(text);
  if (bad.length)
    fail(`${file}: apt-get install without --no-install-recommends: ${bad[0].slice(0, 80)}`);
}
for (const name of Object.keys(ROOT_ALLOWED)) {
  if (!dockerfiles.includes(name))
    fail(`ROOT_ALLOWED names ${name}, which no longer exists - delete it`);
}

console.log('\ndeployed compose files');
for (const rel of COMPOSE_FILES) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const rootUsers = text.split(/\r?\n/).filter((l) => /^\s+user:\s*["']?(root|0)\b/.test(l));
  if (rootUsers.length) fail(`${rel} sets a service back to root: ${rootUsers[0].trim()}`);
  else ok(`${rel} sets no service to root`);
}

console.log(`\n${checks} check(s), ${failures} failed`);
if (failures) process.exit(1);
