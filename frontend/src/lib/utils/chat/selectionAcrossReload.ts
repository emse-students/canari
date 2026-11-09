/**
 * Keeps the open conversation across a reload that is not the user's doing.
 *
 * A tab that is promoted to MLS leader (or yields the lead) reloads so its in-memory state is the
 * one on disk (WP-MULTITAB-1). The reload wipes the selection, so the conversation the user was
 * reading vanished at the moment the other tab closed. The page already has ONE way to land on a
 * conversation after a load - the `canari_pending_contact` key `MainChatPage` applies once logged
 * in - so this writes the open one there and no second mechanism exists.
 */

/** The sessionStorage key `MainChatPage` reads once the session is live. */
export const PENDING_CONTACT_KEY = 'canari_pending_contact';

/** Names the open conversation key, or '' when none is open. Registered by the singleton module. */
let selectionProvider: () => string = () => '';

/** Registers what "the open conversation" means (the salon first, else the contact). */
export function setSelectionProvider(provider: () => string): void {
  selectionProvider = provider;
}

/**
 * Writes the open conversation where the next load picks it up. Never throws: a missing storage
 * only costs the selection, and says so.
 */
export function rememberSelectionForReload(log: (message: string) => void): void {
  let id = '';
  try {
    id = selectionProvider();
    if (!id) return;
    sessionStorage.setItem(PENDING_CONTACT_KEY, id);
    log('[TAB] Open conversation kept across the reload.');
  } catch (e) {
    log(`[TAB] Could not keep the open conversation across the reload: ${String(e)}`);
  }
}
