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
}

interface PendingConfirm extends Required<ConfirmOptions> {
  message: string;
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
      confirmLabel: opts.confirmLabel ?? 'Confirmer',
      cancelLabel: opts.cancelLabel ?? 'Annuler',
      danger: opts.danger ?? false,
      resolve,
    };
  });
}

/** Called by ConfirmDialog to resolve the pending promise and clear state. */
export function resolveConfirm(confirmed: boolean): void {
  _pending?.resolve(confirmed);
  _pending = null;
}
