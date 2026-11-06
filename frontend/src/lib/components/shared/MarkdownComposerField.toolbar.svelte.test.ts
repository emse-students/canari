// @vitest-environment happy-dom
/**
 * The field's DEFAULT toolbar is still the icon-only block that heads the editor: the labelled-chip
 * layout is opt-in (`chipClass`), reserved for the post composer's pinned bar.
 */
import { it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MarkdownComposerField from './MarkdownComposerField.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

it('renders the icon-only default toolbar above the editor', () => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(MarkdownComposerField, { target, props: { value: '' } });
  mounted.push(() => unmount(component));
  flushSync();

  const buttons = Array.from(target.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'));
  expect(buttons).toHaveLength(8);
  for (const b of buttons) {
    expect(b.textContent?.trim()).toBe('');
    expect(b.className).not.toContain('rounded-full');
  }
});
