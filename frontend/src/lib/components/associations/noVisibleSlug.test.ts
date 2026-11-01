/**
 * A TECHNICAL ID IS NEVER SHOWN TO, TYPED BY, OR EDITED BY A PERSON (user, 2026-10-26) - applied to
 * the association / list / institution slug. It stays the URL segment and the server derives it from
 * the name. Read as SOURCE with comments stripped, like `associationsHeader.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutAnyComments } from '$lib/styles/markupSources';

const read = (rel: string) =>
  withoutAnyComments(readFileSync(join(process.cwd(), 'src', rel), 'utf8'));

describe('the creation flow asks for no slug', () => {
  const src = read('lib/components/associations/AssociationCreatePage.svelte');

  it('has no slug field, state, placeholder or hint, and sends none', () => {
    // The ONLY mentions left are the server's answer, used to redirect to the new page, and the
    // typed refusal when no free slug could be derived.
    const refusal = /ASSOCIATION_SLUG_EXHAUSTED|assoc_new_error_slug_exhausted|no free slug/g;
    expect(src.replace(refusal, '').match(/slug/gi)?.length).toBe(
      src.match(/created\.slug/g)?.length
    );
    expect(src).not.toMatch(/slugify|slug:|bind:value=\{slug\}|assoc_new_slug_hint/);
  });

  it('maps the typed no-free-slug refusal to a fr/en sentence, never the server prose', () => {
    expect(src).toContain('err.code === ASSOCIATION_SLUG_EXHAUSTED');
    expect(src).toContain('m.assoc_new_error_slug_exhausted()');
  });

  it('is submittable with a name alone (plus the reach it already checks)', () => {
    expect(src).toContain('!name.trim() || reachIncomplete');
  });
});

describe('no screen prints @slug', () => {
  it.each([
    'lib/components/associations/AssociationDetailView.svelte',
    'routes/associations/[slug]/edit/[[section]]/+page.svelte',
    'routes/lists/[slug]/edit/[[section]]/+page.svelte',
  ])('%s', (rel) => {
    expect(read(rel)).not.toMatch(/@\{?\$?\{?(asso|list)\??\.slug/);
    expect(read(rel)).not.toMatch(/`@\$\{/);
  });

  it('the list header keeps the parent name and the edit page keeps the promo year', () => {
    expect(read('lib/components/associations/AssociationDetailView.svelte')).toContain(
      'asso.parentName'
    );
    expect(read('routes/lists/[slug]/edit/[[section]]/+page.svelte')).toContain(
      'm.list_campaigns_heading({ year: list.promo })'
    );
  });
});
