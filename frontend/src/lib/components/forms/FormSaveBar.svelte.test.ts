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

  it('says where the autosave stands, in words, and warns when an edit is not on the server', () => {
    const cases = [
      ['saving', m.form_autosave_saving(), false],
      ['saved', m.form_autosave_saved(), false],
      ['offline', m.form_autosave_offline(), true],
      ['error', m.form_autosave_error(), true],
      ['conflict', m.form_autosave_conflict(), true],
    ] as const;
    for (const [status, text, warns] of cases) {
      const root = render({ onSave: null, autosaveStatus: status });
      const line = root.querySelector('[data-testid="autosave-status"]')!;
      expect(line.textContent?.trim()).toBe(text);
      expect(line.className.includes('text-amber-warn')).toBe(warns);
      document.body.innerHTML = '';
    }
    // Nothing typed yet: no line at all.
    expect(
      render({ onSave: null, autosaveStatus: 'idle' }).querySelector(
        '[data-testid="autosave-status"]'
      )
    ).toBeNull();
  });

  it('a published form with unpublished edits: "Publier les modifications" and "Abandonner", no save button', () => {
    const onPublish = vi.fn();
    const onDiscard = vi.fn();
    const root = render({
      onSave: null,
      autosaveStatus: 'saved',
      publish: {
        onPublish,
        blockedReason: null,
        busy: false,
        label: m.form_publish_changes_button(),
      },
      discard: { onDiscard, busy: false },
    });
    expect(buttons(root)).toHaveLength(2);
    const publish = root.querySelector<HTMLButtonElement>('[data-testid="publish-button"]')!;
    expect(publish.textContent).toContain(m.form_publish_changes_button());
    publish.click();
    root.querySelector<HTMLButtonElement>('[data-testid="discard-changes"]')!.click();
    expect([onPublish.mock.calls.length, onDiscard.mock.calls.length]).toEqual([1, 1]);
  });
});

describe('FormSaveBar - the closing date offered at publication', () => {
  const suggestion = { kind: 'standard', days: 14, value: '2026-12-05T23:59' } as const;
  const offer = () => document.querySelector('[data-testid="close-suggestion"]');
  const accept = () =>
    document.querySelector<HTMLButtonElement>('[data-testid="close-suggestion-accept"]')!;
  const keepOpen = () =>
    document.querySelector<HTMLButtonElement>('[data-testid="close-suggestion-keep-open"]')!;

  it('offers the date instead of publishing when the form has none, and publishes nothing yet', () => {
    const onPublish = vi.fn();
    const root = render({
      publish: { onPublish, blockedReason: null, busy: false, closingSuggestion: () => suggestion },
    });
    publishButton(root)!.click();
    flushSync();
    expect(offer()).not.toBeNull();
    expect(onPublish).not.toHaveBeenCalled();
    // "Publier" waits for the answer: no second press can publish past the question.
    expect(publishButton(root)!.disabled).toBe(true);
  });

  it('accepting writes the date into the editor FIRST, then publishes', () => {
    const calls: string[] = [];
    const root = render({
      publish: {
        onPublish: () => calls.push('publish'),
        onAcceptClosing: (value: string) => calls.push(`accept:${value}`),
        blockedReason: null,
        busy: false,
        closingSuggestion: () => suggestion,
      },
    });
    publishButton(root)!.click();
    flushSync();
    accept().click();
    flushSync();
    expect(calls).toEqual(['accept:2026-12-05T23:59', 'publish']);
    expect(offer()).toBeNull();
  });

  it('"Laisser ouvert" is one tap: it publishes with no date written', () => {
    const onAcceptClosing = vi.fn();
    const onPublish = vi.fn();
    const root = render({
      publish: {
        onPublish,
        onAcceptClosing,
        blockedReason: null,
        busy: false,
        closingSuggestion: () => suggestion,
      },
    });
    publishButton(root)!.click();
    flushSync();
    keepOpen().click();
    flushSync();
    expect(onAcceptClosing).not.toHaveBeenCalled();
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('asks ONCE: a publication refused afterwards is pressed again without the question', () => {
    const onPublish = vi.fn();
    const root = render({
      publish: { onPublish, blockedReason: null, busy: false, closingSuggestion: () => suggestion },
    });
    publishButton(root)!.click();
    flushSync();
    keepOpen().click();
    flushSync();
    publishButton(root)!.click();
    flushSync();
    expect(offer()).toBeNull();
    expect(onPublish).toHaveBeenCalledTimes(2);
  });

  it('publishes at once when the form already has a date (nothing to offer)', () => {
    const onPublish = vi.fn();
    const root = render({
      publish: { onPublish, blockedReason: null, busy: false, closingSuggestion: () => null },
    });
    publishButton(root)!.click();
    expect(offer()).toBeNull();
    expect(onPublish).toHaveBeenCalledTimes(1);
  });
});
