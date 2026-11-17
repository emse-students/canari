#!/usr/bin/env bun
/**
 * Self-tests for `picomatch-premise.mjs`: the premise behind every GHSA-fc5q-39xc-vjpf ignore must
 * HOLD on the shape it was measured on (2026-11-17) and FAIL on each way that shape can change. An
 * assertion that has never been seen to fail is a comment.
 *
 *   bun .github/scripts/tests/picomatch-premise.test.mjs   (no network, no install)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PREMISES, premiseProblems } from '../picomatch-premise.mjs';

const work = mkdtempSync(join(tmpdir(), 'picomatch-premise-'));
let failures = 0;
let n = 0;

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

/** A tree: `root` is its package.json, `pkgs` maps an installed path to its package.json, `files` any other file. */
function tree({ root, pkgs = {}, files = {} }) {
  const dir = join(work, `t${n++}`);
  write(join(dir, 'package.json'), root);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  for (const [path, pkg] of Object.entries(pkgs)) write(join(dir, 'node_modules', path, 'package.json'), pkg);
  for (const [path, content] of Object.entries(files)) write(join(dir, path), content);
  return dir;
}

function expect(name, dir, premise, wantHolds) {
  const problems = premiseProblems(dir, premise);
  const holds = problems.length === 0;
  if (holds === wantHolds) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}: wanted ${wantHolds ? 'holds' : 'refused'}, got ${holds ? 'holds' : problems.join(' | ')}`);
  }
}

// ---- the services: typeorm > tinyglobby > picomatch, fed classes only ----------------------------
const service = PREMISES['apps/core-service'];
const servicePkgs = {
  typeorm: { name: 'typeorm', dependencies: { tinyglobby: '^0.2' } },
  tinyglobby: { name: 'tinyglobby', dependencies: { fdir: '^6', picomatch: '^4' } },
  fdir: { name: 'fdir', peerDependencies: { picomatch: '^4' } },
  picomatch: { name: 'picomatch' },
  jest: { name: 'jest', dependencies: { picomatch: '^4' } },
};
const loader = { 'node_modules/typeorm/util/DirectoryExportedClassesLoader.js': 'const t = require("tinyglobby");' };
const module = { 'src/app.module.ts': 'TypeOrmModule.forRoot({\n  entities: [\n    User,\n    Group,\n  ],\n  synchronize: false,\n})' };
const serviceRoot = { name: 's', dependencies: { typeorm: '1' }, devDependencies: { jest: '30' } };

expect('service: the measured shape holds (a dev-only picomatch parent is not shipped)',
  tree({ root: serviceRoot, pkgs: servicePkgs, files: { ...loader, ...module } }), service, true);
expect('service: a spec file passing strings is not shipped, so it does not count',
  tree({ root: serviceRoot, pkgs: servicePkgs, files: { ...loader, ...module, 'src/x.integration.spec.ts': "entities: ['dist/**/*.js']," } }), service, true);
expect('service: no picomatch shipped at all holds without asking TypeORM anything',
  tree({ root: { name: 's', dependencies: {} }, pkgs: servicePkgs }), service, true);
expect('service: another RUNTIME package depending on picomatch is refused',
  tree({ root: { ...serviceRoot, dependencies: { typeorm: '1', micromatch: '4' } }, pkgs: { ...servicePkgs, micromatch: { name: 'micromatch', dependencies: { picomatch: '^2' } } }, files: { ...loader, ...module } }), service, false);
expect('service: the service itself depending on tinyglobby is refused',
  tree({ root: { ...serviceRoot, dependencies: { typeorm: '1', tinyglobby: '0.2' } }, pkgs: servicePkgs, files: { ...loader, ...module } }), service, false);
expect('service: a string glob in entities is refused',
  tree({ root: serviceRoot, pkgs: servicePkgs, files: { ...loader, 'src/app.module.ts': "forRoot({ entities: [__dirname + '/**/*.entity.js'], })" } }), service, false);
expect('service: a migrations path is refused',
  tree({ root: serviceRoot, pkgs: servicePkgs, files: { ...loader, ...module, 'src/data-source.ts': 'new DataSource({ migrations: ["dist/migrations/*.js"] })' } }), service, false);
expect('service: typeorm globbing from a second module is refused',
  tree({ root: serviceRoot, pkgs: servicePkgs, files: { ...loader, ...module, 'node_modules/typeorm/driver/Other.js': "import g from 'tinyglobby';" } }), service, false);
expect('service: typeorm no longer importing tinyglobby is refused (the measurement is stale)',
  tree({ root: serviceRoot, pkgs: servicePkgs, files: module }), service, false);
expect('service: a required dependency that is not installed is refused (unmeasurable)',
  tree({ root: { ...serviceRoot, dependencies: { typeorm: '1', ghost: '1' } }, pkgs: servicePkgs, files: { ...loader, ...module } }), service, false);

// ---- the frontend: shipped = dependencies + every devDependency not declared build-only ----------
const frontend = PREMISES.frontend;
const fePkgs = {
  svelte: { name: 'svelte' },
  '@sveltejs/kit': { name: '@sveltejs/kit', peerDependencies: { vite: '8' } },
  vite: { name: 'vite', dependencies: { tinyglobby: '^0.2' } },
  tinyglobby: { name: 'tinyglobby', dependencies: { picomatch: '^4' } },
  picomatch: { name: 'picomatch' },
  marked: { name: 'marked' },
};
const feRoot = { name: 'fe', dependencies: { marked: '1' }, devDependencies: { svelte: '5', '@sveltejs/kit': '3', vite: '8' } };

expect('frontend: picomatch only through a build tool (and a kit PEER) holds', tree({ root: feRoot, pkgs: fePkgs }), frontend, true);
expect('frontend: a bundled devDependency reaching picomatch is refused',
  tree({ root: feRoot, pkgs: { ...fePkgs, svelte: { name: 'svelte', dependencies: { tinyglobby: '0.2' } } } }), frontend, false);
expect('frontend: a NEW devDependency counts as shipped until declared build-only',
  tree({ root: { ...feRoot, devDependencies: { ...feRoot.devDependencies, globby: '14' } }, pkgs: { ...fePkgs, globby: { name: 'globby', dependencies: { picomatch: '4' } } } }), frontend, false);
expect('frontend: a runtime dependency reaching picomatch is refused',
  tree({ root: { ...feRoot, dependencies: { marked: '1', tinyglobby: '0.2' } }, pkgs: fePkgs }), frontend, false);
expect('frontend: a nested copy is resolved from its parent first',
  tree({ root: feRoot, pkgs: { ...fePkgs, marked: { name: 'marked', dependencies: { x: '1' } }, 'marked/node_modules/x': { name: 'x' } } }), frontend, true);

// ---- unmeasurable ------------------------------------------------------------------------------
const bare = join(work, 'no-node-modules');
write(join(bare, 'package.json'), { name: 'b' });
expect('a tree with no node_modules is refused', bare, service, false);

rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('picomatch-premise.mjs: every assertion passed.');
