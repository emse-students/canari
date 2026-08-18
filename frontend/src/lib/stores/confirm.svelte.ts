import { m } from '$lib/paraglide/messages';

/**
 * Global imperative confirmation dialog store.
 *
 * Usage: `const ok = await showConfirm('Supprimer ?')` - resolves true if the
 * user clicks the confirm button, false if they cancel or close the dialog.
 * ConfirmDialog in +layout.svelte renders and handles the promise.
 */

export interface ConfirmOptions {
  /** Label for the confirm button (default: "Confirmer"). */
  confirmLabel?: string;
  /** Label for the cancel button (default: "Annuler"). */
  cancelLabel?: string;
  /** When true, renders the confirm button in red (destructive action). */
  danger?: boolean;
  /**
   * When set, the dialog also asks the user to TYPE this exact text, and confirming is
   * impossible until it matches (trimmed on both sides, otherwise exact).
   *
   * For actions that destroy something irreversibly, where "are you sure?" is answered by
   * reflex. Typing the name of what is about to go is the only part of a confirmation that
   * cannot be clicked through without reading it.
   */
  requireText?: string;
}

interface PendingConfirm extends Required<Omit<ConfirmOptions, 'requireText'>> {
  message: string;
  /** `null` when no typed confirmation is required - see {@link ConfirmOptions.requireText}. */
  requireText: string | null;
  resolve: (confirmed: boolean) => void;
}

let _pending = $state<PendingConfirm | null>(null);

/** Reactive accessor for the ConfirmDialog component. */
export const confirmStore = {
  get pending(): PendingConfirm | null {
    return _pending;
  },
};

/**
 * Show a confirmation dialog and await the user's response.
 * Returns `true` if confirmed, `false` if cancelled or dismissed.
 */
export function showConfirm(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    _pending = {
      message,
      confirmLabel: opts.confirmLabel ?? m.common_confirm_button(),
      cancelLabel: opts.cancelLabel ?? m.common_cancel_button(),
      danger: opts.danger ?? false,
      requireText: opts.requireText ?? null,
      resolve,
    };
  });
}

/** Called by ConfirmDialog to resolve the pending promise and clear state. */
export function resolveConfirm(confirmed: boolean): void {
  _pending?.resolve(confirmed);
  _pending = null;
}
