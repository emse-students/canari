#!/usr/bin/env bun
/**
 * DOES `CI passed` REALLY GATE EVERY JOB?
 *
 * `CI passed` is the ONE check the branch ruleset requires, so a job matters exactly as much as that
 * aggregation says it does. Three ways it can stop mattering, none of which any job would notice:
 *
 * - the job is missing from `ci-passed.needs` - it can fail forever and the merge still happens;
 * - `ci-passed` loses `if: always()` - a failed need then SKIPS the aggregation, and a skipped
 *   required check reads as satisfied;
 * - the aggregation script accepts a result it should not - `cancelled` above all, which is what a
 *   timeout or a superseded run leaves behind.
 *
 * So this derives the job list from the workflow, and RUNS the aggregation script itself (lifted out
 * of `ci.yml`, never copied) against the results each case would produce. It also holds the
 * integration job to the Postgres production runs: a SQL gate on another major proves nothing about
 * the server that executes the SQL.
 *
 * Written 2026-10-15 with `test-social-integration`, the job that ended the integration specs'
 * silent skip (docs/wiki/cicd.md).
 *
 * Usage: bun .github/scripts/tests/ci-passed-gate.test.mjs   (no network; needs bash and jq)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ci = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  failures += 1;
};

/** The text of one top-level job, from its key to the next job's (or the end of the file). */
function jobBlock(name) {
  const jobs = ci.slice(ci.indexOf('\njobs:\n'));
  const start = jobs.indexOf(`\n  ${name}:\n`);
  if (start === -1) return null;
  const rest = jobs.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Every top-level job key under `jobs:`. */
function jobNames() {
  const jobs = ci.slice(ci.indexOf('\njobs:\n'));
  return [...jobs.matchAll(/\n  ([a-z0-9-]+):\n/g)].map((m) => m[1]);
}

/** The `run: |` script of a job's step, dedented. */
function runScript(block) {
  const lines = block.split('\n');
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  if (at === -1) return null;
  const body = [];
  let indent = null;
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const lead = line.length - line.trimStart().length;
    indent ??= lead;
    if (lead < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const names = jobNames();
const gate = jobBlock('ci-passed');

console.log('every job is a need of `CI passed`:');
if (!gate || names.length < 2) {
  bad('read no `ci-passed` job, or no jobs at all - the parser is wrong, not the workflow');
} else {
  const needsText = gate.slice(gate.indexOf('needs:'), gate.indexOf('runs-on:'));
  const needs = new Set([...needsText.matchAll(/[a-z0-9-]+/g)].map((m) => m[0]));
  for (const name of names.filter((n) => n !== 'ci-passed')) {
    if (needs.has(name)) ok(`ci-passed needs ${name}`);
    else bad(`ci-passed does not need ${name} - that job can fail and the merge still happens`);
  }
  if (/\n    if: always\(\)\n/.test(gate)) ok('ci-passed runs `if: always()`, so a failed need cannot skip it');
  else bad('ci-passed lacks `if: always()` - a failed need SKIPS it, and a skipped required check passes');
}

console.log('the aggregation refuses every result but success and skipped:');
const script = gate ? runScript(gate) : null;
if (!script || !script.includes('RESULTS')) {
  bad('found no aggregation script reading RESULTS in ci-passed');
} else {
  const cases = [
    ['all success', { a: 'success', 'test-social-integration': 'success' }, 0],
    ['success and skipped', { a: 'success', 'test-social-integration': 'skipped' }, 0],
    ['the integration job FAILED', { a: 'success', 'test-social-integration': 'failure' }, 1],
    ['the integration job was CANCELLED', { a: 'success', 'test-social-integration': 'cancelled' }, 1],
  ];
  for (const [what, results, want] of cases) {
    const needs = Object.fromEntries(
      Object.entries(results).map(([k, result]) => [k, { result, outputs: {} }])
    );
    const run = spawnSync('bash', ['-c', script], {
      env: { ...process.env, RESULTS: JSON.stringify(needs) },
      encoding: 'utf8',
    });
    if (run.error) bad(`${what}: could not run the script (${run.error.message})`);
    else if (run.status === want) ok(`${what}: exit ${run.status}`);
    else bad(`${what}: exit ${run.status}, expected ${want}\n${run.stdout}${run.stderr}`);
  }
}

console.log('the integration job runs on the database production runs:');
const it = jobBlock('test-social-integration');
if (!it) {
  bad('no test-social-integration job - the integration specs run nowhere again');
} else {
  const image = /\n\s+image: (postgres:\S+)/.exec(it)?.[1];
  const prod = /\n\s+image: (postgres:\S+)/.exec(
    readFileSync(resolve(repoRoot, 'infrastructure/docker-compose.prod.yml'), 'utf8')
  )?.[1];
  if (image && prod && image === prod) ok(`same image as production: ${image}`);
  else bad(`integration job runs ${image}, production runs ${prod} - bump them together`);
  if (/SOCIAL_IT_DATABASE_URL: postgres:\/\//.test(it)) ok('it sets SOCIAL_IT_DATABASE_URL');
  else bad('it does not set SOCIAL_IT_DATABASE_URL - every spec would skip, and pass');
  // The live seat scripts (cap atomicity, viewer count, expiry) need a REAL Redis, the production one.
  const redisImage = /\n\s+image: (redis:\S+)/.exec(it)?.[1];
  const prodRedis = /\n\s+image: (redis:\S+)/.exec(
    readFileSync(resolve(repoRoot, 'infrastructure/docker-compose.prod.yml'), 'utf8')
  )?.[1];
  if (redisImage && prodRedis && redisImage === prodRedis) ok(`same Redis as production: ${redisImage}`);
  else bad(`integration job runs ${redisImage}, production runs ${prodRedis} - bump them together`);
  if (/SOCIAL_IT_REDIS_URL: redis:\/\//.test(it)) ok('it sets SOCIAL_IT_REDIS_URL');
  else bad('it does not set SOCIAL_IT_REDIS_URL - the live seat scripts would skip, and pass');
  if (/live-seats\\\.spec\\\.ts/.test(it)) ok('it selects live-seats.spec.ts');
  else bad('its pattern does not select live-seats.spec.ts - the seat scripts run nowhere');
}

console.log('the addressing scripts run against a real Redis:');
{
  const rust = /\n  test-rust:[\s\S]*?(?=\n  [a-z-]+:\n)/.exec(ci)?.[0] ?? '';
  if (/image: redis:/.test(rust)) ok('test-rust runs a Redis service');
  else bad('test-rust runs no Redis - the gateway presence scripts would run nowhere');
  if (/GATEWAY_IT_REDIS_URL: redis:\/\//.test(rust)) ok('test-rust sets GATEWAY_IT_REDIS_URL');
  else bad('test-rust does not set GATEWAY_IT_REDIS_URL - the gateway presence tests fail under CI');
  const boot = /\n  boot-nest-apps:[\s\S]*?(?=\n  [a-z-]+:\n)/.exec(ci)?.[0] ?? '';
  if (/CHAT_DELIVERY_IT_REDIS_URL: redis:\/\//.test(boot) && /addressing\.redis/.test(boot)) {
    ok('boot-nest-apps runs addressing.redis with CHAT_DELIVERY_IT_REDIS_URL');
  } else bad('boot-nest-apps does not run addressing.redis against Redis - the publish script runs nowhere');
}

console.log('the chat-delivery integration job runs on the database production runs:');
const chatIt = jobBlock('test-chat-delivery-integration');
if (!chatIt) {
  bad('no test-chat-delivery-integration job - the chat-delivery integration specs run nowhere');
} else {
  const image = /\n\s+image: (postgres:\S+)/.exec(chatIt)?.[1];
  const prod = /\n\s+image: (postgres:\S+)/.exec(
    readFileSync(resolve(repoRoot, 'infrastructure/docker-compose.prod.yml'), 'utf8')
  )?.[1];
  if (image && prod && image === prod) ok(`same image as production: ${image}`);
  else bad(`chat-delivery integration job runs ${image}, production runs ${prod} - bump them together`);
  if (/CHAT_DELIVERY_IT_DATABASE_URL: postgres:\/\//.test(chatIt)) ok('it sets CHAT_DELIVERY_IT_DATABASE_URL');
  else bad('it does not set CHAT_DELIVERY_IT_DATABASE_URL - every spec would skip, and pass');
  // The seat lock's orderings run here too (`seat-lock.integration.spec.ts`): a spec that skipped
  // must fail the job, never pass it.
  if (/numPendingTests/.test(chatIt)) ok('it refuses a skipped test');
  else bad('it does not read the skipped count - a spec that skipped would pass');
}

console.log('every Redis CI runs is the one production runs:');
{
  const prodRedis = /\n\s+image: (redis:\S+)/.exec(
    readFileSync(resolve(repoRoot, 'infrastructure/docker-compose.prod.yml'), 'utf8')
  )?.[1];
  const ciRedis = [...ci.matchAll(/\n\s+image: (redis:\S+)/g)].map((x) => x[1]);
  if (ciRedis.length === 0) bad('ci.yml runs no Redis at all');
  for (const image of ciRedis) {
    if (image === prodRedis) ok(`ci.yml: ${image}`);
    else bad(`ci.yml runs ${image}, production runs ${prodRedis} - bump them together`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`FAIL: ${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('OK: `CI passed` needs every job, survives a failed need, and refuses failure and cancellation.');
