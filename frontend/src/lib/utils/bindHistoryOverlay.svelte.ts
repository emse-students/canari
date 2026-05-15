import { pushHistoryOverlay, closeHistoryOverlayFromUi } from './historyOverlayStack';

/**
 * Syncs a boolean overlay open state with the browser history stack.
 * Use for modals, drawers, and mobile full-screen panels.
 */
export function bindHistoryOverlay(getOpen: () => boolean, onClose: () => void) {
  let closeRef: (() => void) | null = null;

  function syncOpen() {
    if (getOpen() && !closeRef) {
      closeRef = () => onClose();
      pushHistoryOverlay(closeRef);
    } else if (!getOpen()) {
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

  return {
    syncOpen,
    dismissFromUi,
    /** Call from popstate-driven close paths if needed */
    clearRef() {
      closeRef = null;
    },
  };
}
