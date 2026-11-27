#!/usr/bin/env bun
/**
 * THE `school_mail` CLAIM NAMES THE CONTRACT'S DOMAINS, AND ONLY CANARI CAN ASK FOR IT
 * (docs/wiki/mail-client-transport.md#eligibility, owner 2026-11-27).
 *
 * MiConnect's mapping (`miconnect-claim-school-mail`, 10-mappings.yaml) is Python inside YAML: no
 * import can hand it libs/contracts/mail-domains.json, so it writes the domains itself and this test
 * holds them EQUAL to the contract's keys - the list core-service, the relay and the client also use.
 * And the claim exists so that ONE application sees a real address: it is bound to Canari's three
 * providers (50-providers.yaml) and to no other. The behaviour of the expression (CAS-created
 * accounts only, never an Alumni address) is proven by evaluating it on a running MiConnect
 * (infrastructure/authentik/test-school-mail-claim.py, through test-blueprints.sh).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');

const contract = JSON.parse(read('libs', 'contracts', 'mail-domains.json'));
const mappings = read('infrastructure', 'authentik', 'blueprints', '10-mappings.yaml');
const providers = read('infrastructure', 'authentik', 'blueprints', '50-providers.yaml');

const failures = [];
const need = (cond, what) => {
  if (!cond) failures.push(what);
};

const start = mappings.indexOf('name: "miconnect-claim-school-mail"');
need(start >= 0, 'no miconnect-claim-school-mail mapping');
const end = mappings.indexOf('\n  - model:', start);
const entry = mappings.slice(start, end < 0 ? undefined : end);
const tuple = entry.match(/SCHOOL_DOMAINS = \(([^)]*)\)/)?.[1] ?? '';
const named = [...tuple.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
need(
  JSON.stringify([...named].sort()) === JSON.stringify(Object.keys(contract.classes).sort()),
  `the mapping names ${JSON.stringify(named)}, the contract ${JSON.stringify(Object.keys(contract.classes))}`
);
need(/scope_name: "school_mail"/.test(entry), 'the mapping is not on its own scope, school_mail');
need(/source__slug="cas-emse"/.test(entry), 'the mapping does not require the CAS link');

// Every provider block, by name, and whether it binds the mapping.
const blocks = providers.split(/\n  - model: /).slice(1);
const binding = blocks
  .filter((b) => b.includes('miconnect-claim-school-mail'))
  .map((b) => b.match(/name: "([^"]+)"/)?.[1]);
need(
  JSON.stringify(binding.sort()) ===
    JSON.stringify(['miconnect-canari', 'miconnect-canari-dev', 'miconnect-canari-local']),
  `school_mail is bound to ${JSON.stringify(binding)}, not exactly Canari's three providers`
);

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("school-mail-claim: the mapping names the contract's domains, bound to Canari's providers only");
