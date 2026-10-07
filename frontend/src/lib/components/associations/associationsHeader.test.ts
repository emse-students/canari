/**
 * THE THREE DIRECTORIES SHARE ONE HEADER AND ONE CREATION FLOW, AND NEITHER MAY BE COPIED BACK.
 *
 * `/institutions` had no creation at all while `/lists` had its own button and its own form, and the
 * four header buttons of `/associations` mixed navigation with creation. What is asserted is the
 * wiring, read as SOURCE with comments stripped: every directory draws `AssociationsHeader` with its
 * own section, none hand-rolls a header or a creation link, and every `/new` route is the shared
 * flow parametrised by its type.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutAnyComments } from '$lib/styles/markupSources';

const read = (rel: string) =>
  withoutAnyComments(readFileSync(join(process.cwd(), 'src', rel), 'utf8'));

const DIRECTORIES = [
  ['associations', 'routes/associations/+page.svelte'],
  ['lists', 'routes/lists/+page.svelte'],
  ['institutions', 'routes/institutions/+page.svelte'],
] as const;

const CREATIONS = [
  ['association', 'routes/associations/new/+page.svelte'],
  ['list', 'routes/lists/new/+page.svelte'],
  ['institution', 'routes/institutions/new/+page.svelte'],
] as const;

describe('the directories draw the one header', () => {
  for (const [section, file] of DIRECTORIES) {
    it(`${file} is the "${section}" section and holds no header or creation link of its own`, () => {
      const src = read(file);
      expect(src).toContain('<AssociationsHeader');
      expect(src).toContain(`section="${section}"`);
      expect(src).not.toContain('<PageHeader');
      expect(src).not.toMatch(/href="\/(associations|lists|institutions)\/new"/);
    });
  }

  it('offers creation of an institution to a global admin only', () => {
    expect(read('routes/institutions/+page.svelte')).toContain('isGlobalAdmin()');
  });
});

describe('the creation routes are one flow, parametrised by type', () => {
  for (const [kind, file] of CREATIONS) {
    it(`${file} renders the shared page for "${kind}"`, () => {
      expect(read(file)).toContain(`<AssociationCreatePage kind="${kind}"`);
    });
  }

  it('the shared flow sends the type, writes the reach of an institution and refuses a non-admin', () => {
    const src = read('lib/components/associations/AssociationCreatePage.svelte');
    expect(src).toContain('setAssociationAudiences');
    expect(src).toContain('reachChoiceToRules');
    expect(src).toMatch(/kind === 'institution' && !isGlobalAdmin\(\)/);
  });
});

describe('the header separates navigation from the one creation', () => {
  const src = read('lib/components/associations/AssociationsHeader.svelte');

  it('marks the current directory and offers a creation per section', () => {
    expect(src).toContain('aria-current');
    expect(src).toContain('/institutions/new');
    expect(src).toContain('/lists/new');
    expect(src).toContain('/associations/new');
  });
});
