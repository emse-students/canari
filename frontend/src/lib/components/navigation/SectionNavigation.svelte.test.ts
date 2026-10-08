/**
 * THE PATH AND THE HUB: what a reader sees and where each link goes.
 *
 * Both are plain links, so Back/reload/sharing are the router's; what is pinned here is that every
 * crumb is a link, the arrow is the PREVIOUS crumb, the middle of a long path folds on a phone
 * only, and a hub row carries its summary and its destination.
 */
import { it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { Users } from '@lucide/svelte';
import Breadcrumb from './Breadcrumb.svelte';
import SectionHub from './SectionHub.svelte';
import { foldedCrumbCount } from './breadcrumb';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- one helper for components of different props
function render(component: Component<any>, props: Record<string, unknown>): HTMLElement {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(component, { target, props });
  flushSync();
  mounted.push(() => unmount(instance));
  return target;
}

const TRAIL = [
  { label: 'Associations', href: '/associations' },
  { label: 'BDE', href: '/associations/bde' },
  { label: 'Gestion', href: '/associations/bde/edit' },
  { label: 'Partenariats', href: '/associations/bde/edit/partnerships' },
];

it('draws every crumb as a link and marks the last as the current page', () => {
  const root = render(Breadcrumb, { crumbs: TRAIL });
  const links = [...root.querySelectorAll<HTMLAnchorElement>('ol a')];
  expect(links.map((a) => a.getAttribute('href'))).toEqual(TRAIL.map((c) => c.href));
  expect(links.at(-1)?.getAttribute('aria-current')).toBe('page');
  expect(links[0].hasAttribute('aria-current')).toBe(false);
});

it('points the back arrow at the previous crumb', () => {
  const root = render(Breadcrumb, { crumbs: TRAIL });
  expect(root.querySelector('[data-breadcrumb-back]')?.getAttribute('href')).toBe(
    '/associations/bde/edit'
  );
});

it('has no back arrow for a path of one', () => {
  const root = render(Breadcrumb, { crumbs: [TRAIL[0]] });
  expect(root.querySelector('[data-breadcrumb-back]')).toBeNull();
});

it('folds the middle of a long path on a phone and never the root or the tail', () => {
  expect(foldedCrumbCount(3)).toBe(0);
  expect(foldedCrumbCount(4)).toBe(1);
  const root = render(Breadcrumb, { crumbs: TRAIL });
  const items = [...root.querySelectorAll('ol > li')].filter((li) => li.querySelector('a'));
  const hiddenOnPhone = items.filter((li) => li.className.includes('hidden sm:flex'));
  expect(hiddenOnPhone).toHaveLength(1);
  expect(hiddenOnPhone[0].textContent).toContain('BDE');
});

it('draws a hub row as a link with its label, summary and a danger tone', () => {
  const root = render(SectionHub, {
    label: 'Sections',
    rows: [
      { key: 'members', href: '/x/members', label: 'Membres', icon: Users, summary: '12 membres' },
      { key: 'danger', href: '/x/danger', label: 'Danger', icon: Users, tone: 'danger' },
    ],
  });
  const members = root.querySelector<HTMLAnchorElement>('[data-hub-row="members"]')!;
  expect(members.getAttribute('href')).toBe('/x/members');
  expect(members.textContent).toContain('Membres');
  expect(members.textContent).toContain('12 membres');
  const danger = root.querySelector<HTMLAnchorElement>('[data-hub-row="danger"]')!;
  expect(danger.className).toContain('text-red-err');
  expect(danger.textContent).not.toContain('membres');
});
