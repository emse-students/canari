#!/usr/bin/env bun
/**
 * THE ROUTE-PARAMETER GUARD IS ONE FILE, COPIED INTO EACH NEST SERVICE THAT USES IT.
 *
 * The services share no TypeScript package: each is built from its own directory, and their common
 * guards have always been one copy per service. A copy that drifts is the cost of that, so this
 * holds the copies of `src/common/route-params.ts` and of its spec byte-identical, and fails on a
 * service that provides the guard without carrying the three files that make it mean something:
 * the guard, its spec, and the coverage spec that walks the service's own `AppModule`.
 *
 * Run by `make test-ci-scripts`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const APPS = join(import.meta.dir, '..', '..', '..', 'apps');
const COPIED = ['src/common/route-params.ts', 'src/common/route-params.spec.ts'];
const COVERAGE = 'src/route-params.coverage.spec.ts';

const failures = [];
const services = readdirSync(APPS).filter((name) => existsSync(join(APPS, name, COPIED[0])));

// The control: an empty scan cannot pass. Three services carry the guard since 2026-11-14.
if (services.length < 3) {
  failures.push(`only ${services.length} service(s) carry ${COPIED[0]} (${services.join(', ')}) - at least 3 expected`);
}

for (const file of COPIED) {
  const texts = new Map();
  for (const service of services) {
    const path = join(APPS, service, file);
    if (!existsSync(path)) {
      failures.push(`${service} carries the guard but not ${file}`);
      continue;
    }
    // Line endings are a checkout setting, not a difference.
    const text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    texts.set(text, [...(texts.get(text) ?? []), service]);
  }
  if (texts.size > 1) {
    const groups = [...texts.values()].map((group) => group.join(' = ')).join('  !=  ');
    failures.push(`${file} differs between services: ${groups}`);
  }
}

for (const service of services) {
  if (!existsSync(join(APPS, service, COVERAGE))) {
    failures.push(`${service} carries the guard but no ${COVERAGE}: nothing checks that its routes are declared`);
  }
  const appModule = readFileSync(join(APPS, service, 'src/app.module.ts'), 'utf8');
  if (!/providers:\s*\[[^\]]*\bROUTE_PARAMS_GUARD\b/.test(appModule)) {
    failures.push(`${service}'s AppModule does not provide ROUTE_PARAMS_GUARD: its declarations are read by nothing`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exit(1);
}
console.log(`OK: ${COPIED.length} file(s) identical across ${services.length} services (${services.join(', ')}), each with its coverage spec and the guard provided.`);
