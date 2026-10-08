/**
 * The `?section=` links written before sections became route segments keep working: a notification
 * already in someone's list, the "create a form" return and the post-creation landing.
 */
import { it, expect } from 'vitest';
import { load } from './+page';

type Args = Parameters<typeof load>[0];
function run(slug: string, section: string | undefined, search = ''): unknown {
  try {
    return load({
      params: { slug, section },
      url: new URL(`http://x/associations/${slug}/edit${search}`),
    } as unknown as Args);
  } catch (e) {
    return e;
  }
}

it('redirects ?section=republications to the segment', () => {
  expect(run('bde', undefined, '?section=republications')).toMatchObject({
    status: 307,
    location: '/associations/bde/edit/republications',
  });
});

it('redirects an unknown ?section= and an unknown segment to the hub', () => {
  expect(run('bde', undefined, '?section=nope')).toMatchObject({
    location: '/associations/bde/edit',
  });
  expect(run('bde', 'nope')).toMatchObject({ location: '/associations/bde/edit' });
});

it('lets the hub and a known segment through', () => {
  expect(run('bde', undefined)).toEqual({});
  expect(run('bde', 'members')).toEqual({});
});
