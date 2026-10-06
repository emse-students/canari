/**
 * A PARRAINAGE LIST MAY REPEAT A NAME, AND A REPEATED NAME MUST NOT CRASH THE PROFILE PAGE.
 *
 * The section keyed its rows by `sub ?? full name`. Two unlinked placeholders with the same name,
 * or one person listed as both a parrain and an adoption, gave a duplicate key - which throws in
 * Svelte 5 and replaced the whole profile route with the error screen (found 2026-10-06 from a
 * production report: the page rendered, showed its sponsorship spinner, then broke).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ProfileParrainageSection from './ProfileParrainageSection.svelte';
import ProfileChips from './ProfileChips.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(component: unknown, props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- two components, one harness
  const app = mount(component as any, { target, props });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

const member = (kind: string, sub: string | null) => ({
  prenom: 'Jean',
  nom: 'Dupont',
  level: 2025,
  kind,
  sub,
});

describe('profile lists with a repeated identity', () => {
  it('renders two unlinked godchildren sharing a name', () => {
    const el = render(ProfileParrainageSection, {
      parrains: [],
      fillots: [member('parrainage', null), member('parrainage', null)],
    });
    expect(el.querySelectorAll('li').length).toBe(2);
  });

  it('renders one person listed as both a parrain and an adoption', () => {
    const el = render(ProfileParrainageSection, {
      parrains: [member('parrainage', 'jean.dupont'), member('adoption', 'jean.dupont')],
      fillots: [],
    });
    expect(el.querySelectorAll('li').length).toBe(2);
  });

  it('renders a cursus that repeats a formation and a promo', () => {
    const el = render(ProfileChips, {
      profile: {
        cursus: [
          { formation: 'ICM', promo: 2026 },
          { formation: 'ICM', promo: 2026 },
        ],
        posts: ['EMSE', 'EMSE'],
        campus: null,
      },
    });
    expect(el.querySelectorAll('.rounded-full').length).toBe(4);
  });
});
