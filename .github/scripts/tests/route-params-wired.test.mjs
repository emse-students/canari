#!/usr/bin/env bun
/**
 * A SERVICE THAT CARRIES THE ROUTE-PARAMETER GUARD ALSO CARRIES WHAT MAKES IT MEAN SOMETHING.
 *
 * `src/common/route-params.ts` is one file copied into each Nest service that uses it; that the
 * copies stay byte-identical is `declared-duplicates.test.mjs`'s job (the group is declared in
 * `.github/scripts/lib/declared-duplicates.mjs`), and one spec beside the first copy proves all of
 * them. What nothing else holds is the WIRING, which is per service and is what this checks:
 *
 * - its `AppModule` provides `ROUTE_PARAMS_GUARD` - without it the declarations are read by nothing;
 * - it has `src/route-params.coverage.spec.ts`, the spec that walks its own module graph and fails
 *   on a path parameter no declaration names;
 * - it is in the declared group - a copy outside it could drift unseen.
 *
 * Run by `make test-ci-scripts`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECLARED_GROUPS } from '../lib/declared-duplicates.mjs';

const APPS = join(import.meta.dir, '..', '..', '..', 'apps');
const GUARD = 'src/common/route-params.ts';
const COVERAGE = 'src/route-params.coverage.spec.ts';

const failures = [];
const services = readdirSync(APPS).filter((name) => existsSync(join(APPS, name, GUARD)));
const declared = DECLARED_GROUPS.flatMap((group) => group.files);

// The control: an empty scan cannot pass. Three services carry the guard since 2026-11-14.
if (services.length < 3) {
  failures.push(`only ${services.length} service(s) carry ${GUARD} (${services.join(', ')}) - at least 3 expected`);
}

for (const service of services) {
  if (!declared.includes(`apps/${service}/${GUARD}`)) {
    failures.push(`${service}'s ${GUARD} is not in a declared group: nothing holds it identical to the others`);
  }
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
console.log(`OK: ${services.length} services carry the guard (${services.join(', ')}), each declared, with its coverage spec and the guard provided.`);
