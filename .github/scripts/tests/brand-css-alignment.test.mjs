#!/usr/bin/env bun
/**
 * THE LOGIN PAGE'S CHECKBOX ALIGNMENT IS STILL IN THE BRAND CSS.
 *
 * `70-brand.yaml` holds the ONLY copy of the login CSS. The terms stage and the first-sign-in
 * stage draw their checkboxes from it: without these rules a box hugs the left edge while its label
 * centres in a narrower column and the helper text falls under the box (2026-11-22). Nothing runs a
 * browser in CI, so this pins the three rules by their text, whitespace-insensitive. A rule edited
 * on purpose is edited here too.
 *
 * Run by `make test-ci-scripts`; needs no Docker.
 */
import { readFileSync } from 'node:fs';

const file = new URL('../../../infrastructure/authentik/blueprints/70-brand.yaml', import.meta.url);
const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

const RULES = [
  ['the row is left-aligned', /\.pf-c-check, \.pf-c-radio \{[^}]*text-align: left;/],
  [
    'the helper is hidden when empty',
    /\.pf-c-check \.pf-c-form__helper-text:empty, \.pf-c-radio \.pf-c-form__helper-text:empty \{ display: none;/,
  ],
  ['the stage paragraph is left-aligned', /\.pf-c-form > p \{ text-align: left;/],
];

let failures = 0;
for (const [name, pattern] of RULES) {
  if (pattern.test(css)) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}: 70-brand.yaml's branding_custom_css no longer holds ${pattern}`);
    failures += 1;
  }
}
process.exit(failures ? 1 : 0);
