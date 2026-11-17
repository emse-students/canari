#!/usr/bin/env bun
/**
 * THE PREMISE BEHIND EVERY `GHSA-fc5q-39xc-vjpf` IGNORE (picomatch ReDoS, every version <= 4.0.7,
 * no fixed release on 2026-11-17), asserted on the INSTALLED tree rather than written down.
 *
 * The ReDoS needs an attacker to choose the glob PATTERN. The ignore is granted only where what we
 * SHIP either never loads picomatch, or loads it through one edge whose patterns are ours:
 *
 *   frontend   picomatch is outside the shipped closure. That closure is `dependencies` PLUS every
 *              devDependency not declared build-only below, because svelte, @sveltejs/kit,
 *              protobufjs and parse5 are devDependencies that are BUNDLED. The list is of what may
 *              be LEFT OUT, so a new devDependency counts as shipped until someone says otherwise.
 *   services   picomatch is reached only as `typeorm > tinyglobby > picomatch`, and TypeORM globs
 *              only the STRING entries of `entities` / `migrations` / `subscribers` - so (a) inside
 *              typeorm only `util/DirectoryExportedClassesLoader.js` touches tinyglobby, and (b) no
 *              string reaches it: asserted at RUNTIME by the service's boot spec on the booted
 *              DataSource (this script checks the assertion is still there), plus a grep of the
 *              shipped source for a literal string.
 *
 * An edge is followed through `dependencies` and `optionalDependencies`, never `peerDependencies`:
 * a peer is satisfied by whoever declares it (kit peers vite, which only the build loads), and a
 * peer a runtime package really needs is declared by the root, so it is a root here.
 *
 * Every refusal is an UNMEASURABLE premise too: a tree with no `node_modules`, or a required
 * dependency that is not installed, grants nothing.
 *
 * In the FULL closure (the nightly), the question is different: the build tools DO hold picomatch,
 * and the nightly has reported it. The premise there is that no fixed release exists yet
 * (`unpatchedProblems`), so the nightly is red only on something new.
 *
 *   bun .github/scripts/picomatch-premise.mjs <tree> [production|full]   (exit 0 holds, 1 refused)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** The frontend devDependencies that only the BUILD or the TESTS load; everything else ships. */
export const FRONTEND_BUILD_ONLY = new Set([
  '@inlang/paraglide-js', // compiles messages into src/lib/paraglide; src imports none of it
  // adapter-node's runtime is a template COPIED into build/; its npm deps are rollup plugins.
  '@sveltejs/adapter-node',
  '@sveltejs/adapter-static',
  '@sveltejs/vite-plugin-svelte',
  '@tailwindcss/vite',
  '@tauri-apps/cli',
  '@vitest/coverage-v8',
  'fake-indexeddb',
  'happy-dom',
  'knip',
  'oxfmt',
  'oxlint',
  'protobufjs-cli',
  'sharp',
  'svelte-check',
  'tailwindcss',
  'typescript',
  'vite',
  'vitest',
]);

const SERVICE = {
  shipsDev: false,
  // child -> the only packages of the shipped closure allowed to depend on it
  allowedParents: { picomatch: ['tinyglobby'], tinyglobby: ['typeorm'] },
  typeorm: true,
};

/** Per tree: what ships, and which edges to picomatch it may hold. */
export const PREMISES = {
  frontend: { shipsDev: true, allowedParents: {}, typeorm: false },
  'apps/core-service': SERVICE,
  'apps/social-service': SERVICE,
  'apps/chat-delivery-service': SERVICE,
};

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Node's resolution, from a package directory upwards through every `node_modules`. */
function resolvePackage(name, fromDir, rootDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === rootDir) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Walks the shipped closure of `treeDir` and returns `{ parents, problems }`, where `parents` maps a
 * package name to the set of package names (or `<root>`) that depend on it inside the closure.
 */
export function shippedClosure(treeDir, premise) {
  const problems = [];
  const parents = new Map();
  const root = readJson(join(treeDir, 'package.json'));
  const roots = [...Object.keys(root.dependencies ?? {}), ...Object.keys(root.optionalDependencies ?? {})];
  if (premise.shipsDev) {
    for (const name of Object.keys(root.devDependencies ?? {})) {
      if (!FRONTEND_BUILD_ONLY.has(name) && !name.startsWith('@types/')) roots.push(name);
    }
  }
  const optionalRoots = new Set(Object.keys(root.optionalDependencies ?? {}));
  const seen = new Set();
  const queue = [];
  const edge = (parentName, parentDir, name, optional) => {
    if (!parents.has(name)) parents.set(name, new Set());
    parents.get(name).add(parentName);
    const dir = resolvePackage(name, parentDir, treeDir);
    if (!dir) {
      if (!optional) problems.push(`${parentName} requires ${name}, which is not installed - the closure cannot be measured`);
      return;
    }
    if (!seen.has(dir)) {
      seen.add(dir);
      queue.push(dir);
    }
  };
  for (const name of roots) edge('<root>', treeDir, name, optionalRoots.has(name));
  while (queue.length > 0) {
    const dir = queue.shift();
    const pkg = readJson(join(dir, 'package.json'));
    for (const name of Object.keys(pkg.dependencies ?? {})) edge(pkg.name, dir, name, false);
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) edge(pkg.name, dir, name, true);
  }
  return { parents, problems };
}

/** Every `.js`/`.cjs`/`.mjs` file under `dir`, as a path relative to it. */
function scripts(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') scripts(full, base, out);
    } else if (/\.(c|m)?js$/.test(entry)) {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out;
}

/** Every shipped `.ts` file under `src`: `tsconfig.build.json` excludes every name ending in `spec.ts`. */
function shippedSources(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) shippedSources(full, out);
    else if (/\.ts$/.test(entry) && !entry.endsWith('spec.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** The value written after `key:` - a bracketed list to its matching bracket, else to `,` or EOL. */
function optionValue(text, from) {
  if (text[from] !== '[') return text.slice(from).split(/[,\n}]/)[0];
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}

/** The TypeORM leg: only one module of typeorm globs, and it is fed no string by this service. */
export function typeormProblems(treeDir) {
  const problems = [];
  const typeorm = join(treeDir, 'node_modules', 'typeorm');
  if (!existsSync(typeorm)) return [`${typeorm} is not there, so what TypeORM globs cannot be checked`];
  const globbing = scripts(typeorm)
    .filter((file) => !file.startsWith('browser/'))
    .filter((file) => /(require\(|from\s*)["']tinyglobby["']/.test(readFileSync(join(typeorm, file), 'utf8')));
  const others = globbing.filter((file) => file !== 'util/DirectoryExportedClassesLoader.js');
  if (globbing.length === 0) problems.push('typeorm no longer imports tinyglobby at all - the edge the ignore was measured on is gone');
  if (others.length > 0) problems.push(`typeorm now globs from more than DirectoryExportedClassesLoader: ${others.join(', ')}`);
  // THE AUTHORITATIVE LEG IS AT RUNTIME: the service's boot spec reads `dataSource.options` off the
  // DataSource the real AppModule built and asserts no string is in it - which a shorthand, a const,
  // a spread or a factory cannot evade. It runs in the `boot-nest-apps` job, so here we only assert
  // it is still there.
  const bootSpec = join(treeDir, 'src', 'app-module.boot-spec.ts');
  const boot = existsSync(bootSpec) ? readFileSync(bootSpec, 'utf8') : '';
  if (!boot.includes('GHSA-fc5q-39xc-vjpf') || !boot.includes('dataSource.options')) {
    problems.push('src/app-module.boot-spec.ts no longer asserts, on the booted DataSource, that TypeORM is handed no string path');
  }
  // THE GREP STAYS AS WELL, for what the boot cannot see: it runs here, in the audit job of every
  // pull request and nightly (the boot runs only when a service changed), and it reads every
  // shipped source, including a DataSource built outside the AppModule (a CLI or script), which the
  // boot never constructs. It catches only a LITERAL string; the boot catches the rest.
  for (const file of shippedSources(join(treeDir, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\b(entities|migrations|subscribers)\s*:\s*/g)) {
      const value = optionValue(text, match.index + match[0].length);
      if (/['"`]/.test(value)) {
        problems.push(`${relative(treeDir, file)} hands TypeORM a string in \`${match[1]}\` (${value.trim().slice(0, 80)}) - a glob TypeORM compiles with picomatch`);
      }
    }
  }
  return problems;
}

/** Every reason the premise does not hold for `treeDir` under `premise`; empty when it holds. */
export function premiseProblems(treeDir, premise) {
  if (!existsSync(join(treeDir, 'node_modules'))) return [`${treeDir}/node_modules is not there, so the shipped closure cannot be measured`];
  const { parents, problems } = shippedClosure(treeDir, premise);
  // picomatch first, then every allowed parent that is itself reached, and so on up the chain.
  const pending = ['picomatch'];
  const checked = new Set();
  while (pending.length > 0) {
    const child = pending.shift();
    if (checked.has(child) || !parents.has(child)) continue;
    checked.add(child);
    const allowed = premise.allowedParents[child] ?? [];
    const intruders = [...parents.get(child)].filter((name) => !allowed.includes(name));
    if (intruders.length > 0) problems.push(`${child} is reached in the shipped closure through ${intruders.join(', ')} (allowed: ${allowed.join(', ') || 'nothing'})`);
    // The chain ends at a package with no entry (typeorm): who depends on it is not the question.
    pending.push(...allowed.filter((name) => name in premise.allowedParents));
  }
  if (premise.typeorm && parents.has('picomatch')) problems.push(...typeormProblems(treeDir));
  return problems;
}

export const ADVISORY = 'GHSA-fc5q-39xc-vjpf';

/**
 * THE NIGHTLY'S PREMISE (`full` closure): the advisory has been REPORTED and there is nothing to
 * upgrade to. Read from GitHub's own record of the advisory: every picomatch entry must still have
 * no `first_patched_version`. The day one has, the ignore is refused and the nightly goes red - the
 * one moment there is something to do. A record that cannot be read grants nothing.
 *
 * @param {unknown} advisory the JSON of `GET /advisories/GHSA-fc5q-39xc-vjpf`
 * @returns {string[]} empty when no fixed release exists
 */
export function unpatchedProblems(advisory) {
  if (!advisory || typeof advisory !== 'object' || advisory.ghsa_id !== ADVISORY) return [`the advisory record is not ${ADVISORY}'s, so whether a fix exists is unknown`];
  if (advisory.withdrawn_at) return [`${ADVISORY} was withdrawn on ${advisory.withdrawn_at}: delete the ignore`];
  const entries = (Array.isArray(advisory.vulnerabilities) ? advisory.vulnerabilities : []).filter((v) => v?.package?.ecosystem === 'npm' && v?.package?.name === 'picomatch');
  if (entries.length === 0) return [`${ADVISORY} no longer names npm picomatch, so the record no longer describes this ignore`];
  const patched = entries.map((v) => v.first_patched_version).filter((v) => v !== null && v !== undefined && v !== '');
  if (patched.length > 0) return [`picomatch now has a fixed release (${patched.map((v) => v.identifier ?? v).join(', ')}): upgrade, then delete the ignore`];
  return [];
}

if (import.meta.main) {
  const tree = process.argv[2];
  const closure = process.argv[3] ?? 'production';
  if (closure === 'full') {
    // The nightly: every tree that holds picomatch, one question about the advisory itself.
    const headers = { Accept: 'application/vnd.github+json' };
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    // ONE RETRY, five seconds later: a single dropped request must not turn the nightly red, and a
    // record still unreadable after it is reported (an unread premise grants nothing).
    let problems;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`https://api.github.com/advisories/${ADVISORY}`, { headers });
        problems = res.ok ? unpatchedProblems(await res.json()) : [`the advisory API answered ${res.status} (attempt ${attempt}/2), so whether a fix exists is unknown`];
        if (res.ok) break;
      } catch (err) {
        problems = [`the advisory API could not be reached (${err?.message ?? err}; attempt ${attempt}/2), so whether a fix exists is unknown`];
      }
      if (attempt === 1) {
        console.log(`::warning::${tree}: ${problems[0]} - retrying once in 5 s`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    if (problems.length > 0) {
      for (const p of problems) console.log(`::error::${tree}: ${p}. ${ADVISORY} is not granted in the full closure.`);
      process.exit(1);
    }
    console.log(`    ${tree}: ${ADVISORY} still has no fixed picomatch release; the nightly has reported it, and the ignore holds until one exists.`);
    process.exit(0);
  }
  if (closure !== 'production') {
    console.log(`::error::picomatch-premise: closure '${closure}' is neither production nor full`);
    process.exit(1);
  }
  const premise = PREMISES[tree];
  if (!premise) {
    console.log(`::error::picomatch-premise: no premise is declared for '${tree}' (known: ${Object.keys(PREMISES).join(', ')})`);
    process.exit(1);
  }
  const problems = premiseProblems(tree, premise);
  if (problems.length > 0) {
    for (const p of problems) console.log(`::error::${tree}: ${p}. GHSA-fc5q-39xc-vjpf is not granted.`);
    process.exit(1);
  }
  console.log(`    ${tree}: picomatch is ${premise.typeorm ? 'shipped only as typeorm > tinyglobby, fed no string path' : 'outside the shipped closure'}; the GHSA-fc5q-39xc-vjpf premise holds.`);
}
