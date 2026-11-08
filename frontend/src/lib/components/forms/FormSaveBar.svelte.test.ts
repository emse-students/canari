// @vitest-environment happy-dom
/**
 * The save bar of a DRAFT offers "Publier" beside the save, shut with its reason while a paid form's
 * association cannot collect (owner, 2026-11-08); a published form keeps the one save button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FormSaveBar from './FormSaveBar.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(props: Record<string, unknown>) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(FormSaveBar, {
    target,
    props: {
      titleMissing: false,
      isSubmitting: false,
      summary: '3 questions',
      saveLabel: 'Enregistrer',
      onSave: vi.fn(),
      ...props,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

const buttons = (root: HTMLElement) => [...root.querySelectorAll('button')];
const publishButton = (root: HTMLElement) =>
  buttons(root).find((b) => b.textContent?.includes(m.form_publish_button()));

describe('FormSaveBar', () => {
  it('a published form: one save button, no "Publier"', () => {
    const root = render({});
    expect(buttons(root)).toHaveLength(1);
    expect(publishButton(root)).toBeUndefined();
  });

  it('a draft: "Publier" beside the save, pressed through', () => {
    const onPublish = vi.fn();
    const root = render({ publish: { onPublish, blockedReason: null, busy: false } });
    const button = publishButton(root)!;
    expect(button.disabled).toBe(false);
    button.click();
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[data-testid="publish-blocked-reason"]')).toBeNull();
  });

  it('a paid draft whose association cannot collect: "Publier" shut, the reason said, the save open', () => {
    const onSave = vi.fn();
    const onPublish = vi.fn();
    const reason = m.form_publish_blocked_payments();
    const root = render({ onSave, publish: { onPublish, blockedReason: reason, busy: false } });
    expect(publishButton(root)!.disabled).toBe(true);
    expect(root.querySelector('[data-testid="publish-blocked-reason"]')?.textContent).toContain(
      reason
    );
    const save = buttons(root).find((b) => b !== publishButton(root))!;
    expect(save.disabled).toBe(false);
    save.click();
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
