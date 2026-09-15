import { describe, it, expect, vi, beforeEach } from 'vitest';
import { confirmStore, resolveConfirm, showConfirm } from './confirm.svelte';

/**
 * ONE SLOT MEANS EVERY DIALOG THAT LEAVES IT OWES AN ANSWER.
 *
 * `showConfirm` hands back a promise and stores the resolver in a single `_pending`. A second call
 * overwrites that record, and before 2026-09-15 it overwrote the RESOLVER too: the first dialog
 * disappeared from the screen and its promise never settled, so whatever was awaiting it waited for
 * the rest of the process. Nothing crashed, nothing logged, and the await simply never returned.
 *
 * It stopped being theoretical when `startPushService` began awaiting one of these before it may
 * ask Android for the notification permission - a hung await there leaves a device with no push and
 * nothing said about it.
 */
describe('the confirmation dialog store', () => {
  beforeEach(() => {
    // Nothing may be pending from a previous case, or the replacement assertion tests the wrong
    // dialog. `resolveConfirm` is the only thing that clears the slot.
    if (confirmStore.pending) resolveConfirm(false);
    vi.restoreAllMocks();
  });

  it('resolves the dialog it replaces, rather than dropping its promise', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = showConfirm('Supprimer la communaute ?');
    expect(confirmStore.pending?.message).toBe('Supprimer la communaute ?');

    const second = showConfirm('Quitter la conversation ?');
    expect(confirmStore.pending?.message).toBe('Quitter la conversation ?');

    // The replaced dialog answers `false` - what a user who never saw it decided. Without an
    // explicit await here this assertion would pass on a promise that never settles, so the await
    // IS the assertion: the test hangs and times out if the resolver was dropped.
    await expect(first).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('replaced before it was answered'));

    resolveConfirm(true);
    await expect(second).resolves.toBe(true);
    expect(confirmStore.pending).toBeNull();
  });

  it('carries the labels the caller asked for, and falls back to the common ones', async () => {
    const custom = showConfirm('Activer les notifications ?', {
      confirmLabel: 'Activer',
      cancelLabel: 'Plus tard',
    });
    expect(confirmStore.pending?.confirmLabel).toBe('Activer');
    expect(confirmStore.pending?.cancelLabel).toBe('Plus tard');
    resolveConfirm(false);
    await expect(custom).resolves.toBe(false);

    const plain = showConfirm('Confirmer ?');
    expect(confirmStore.pending?.confirmLabel).toBeTruthy();
    expect(confirmStore.pending?.cancelLabel).toBeTruthy();
    resolveConfirm(true);
    await expect(plain).resolves.toBe(true);
  });
});
