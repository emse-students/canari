import {
  pushHistoryOverlay,
  closeHistoryOverlayFromUi,
  releaseHistoryOverlay,
} from './historyOverlayStack';

/**
 * Syncs a boolean overlay open state with the browser history stack, so the system Back closes the
 * overlay instead of whatever lies under it. Use for modals, drawers, sheets, menus and full-screen
 * panels. Call it during a component's initialisation.
 *
 * IT KEEPS ITSELF IN STEP: it follows `getOpen` in an effect of its own, and it releases its entry
 * when the component is destroyed while open. A surface mounted only while open (a PDF viewer, a
 * prompt under an `{#if}`) is closed by being UNMOUNTED, which no `getOpen` ever reports; its entry
 * stayed live on the stack, and a live entry is what stands the tab swipe down
 * (`historyOverlayStackDepth`). The explicit `syncOpen` stays for callers that already call it.
 *
 * @param getOpen whether the overlay is open now (read reactively).
 * @param onClose closes the overlay; called by the system Back and by {@link dismissFromUi}.
 */
export function bindHistoryOverlay(getOpen: () => boolean, onClose: () => void) {
  let closeRef: (() => void) | null = null;

  function syncOpen() {
    if (getOpen() && !closeRef) {
      closeRef = () => onClose();
      pushHistoryOverlay(closeRef);
    } else if (!getOpen()) {
      // Closed by its owner's state: leave the stack too (see `releaseHistoryOverlay`).
      if (closeRef) releaseHistoryOverlay(closeRef);
      closeRef = null;
    }
  }

  function dismissFromUi() {
    if (closeRef) {
      closeHistoryOverlayFromUi(closeRef);
    } else {
      onClose();
    }
  }

  $effect(() => {
    syncOpen();
  });
  // No dependency, so its cleanup runs once: when the component goes away.
  $effect(() => () => {
    if (closeRef) releaseHistoryOverlay(closeRef);
    closeRef = null;
  });

  return {
    syncOpen,
    dismissFromUi,
    /** Call from popstate-driven close paths if needed */
    clearRef() {
      closeRef = null;
    },
  };
}
