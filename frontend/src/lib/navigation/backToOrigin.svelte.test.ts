// @vitest-environment happy-dom
/**
 * THE ARROWS CARRY THE MARKER the click decision reads, RENDERED (review of #3648: a source-text
 * `toContain` would pass on a comment). Both header shapes: the breadcrumb's arrow and a
 * `PageHeader`'s `backHref` link.
 */
import { afterEach, expect, it } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import Breadcrumb from '$lib/components/navigation/Breadcrumb.svelte';
import PageHeader from '$lib/components/layout/PageHeader.svelte';
import { BACK_LINK_ATTRIBUTE } from './backToOrigin';

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

it("the breadcrumb's arrow is a back link to the previous crumb", () => {
  const root = render(Breadcrumb, {
    crumbs: [
      { label: 'Associations', href: '/associations' },
      { label: 'BDE', href: '/associations/bde' },
    ],
  });
  const arrow = root.querySelector('a[data-breadcrumb-back]')!;
  expect(arrow.hasAttribute(BACK_LINK_ATTRIBUTE)).toBe(true);
  expect(arrow.getAttribute('href')).toBe('/associations');
  // The crumbs themselves are plain links: only the arrow is a Back.
  expect(root.querySelectorAll(`ol a[${BACK_LINK_ATTRIBUTE}]`)).toHaveLength(0);
});

it("a PageHeader's backHref link is a back link", () => {
  const root = render(PageHeader, { title: 'Page', backHref: '/posts', backLabel: 'Retour' });
  const arrow = root.querySelector(`a[${BACK_LINK_ATTRIBUTE}]`)!;
  expect(arrow.getAttribute('href')).toBe('/posts');
});
