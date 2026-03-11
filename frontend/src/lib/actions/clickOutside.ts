export function clickOutside(
  node: HTMLElement,
  params: (() => void) | { enabled: boolean; callback: () => void }
) {
  let callback: () => void;
  let enabled = true;
  let isListening = false;

  const handleClick = (event: Event) => {
    if (enabled && node && !event.composedPath().includes(node)) {
      callback();
    }
  };

  const updateState = (newParams: (() => void) | { enabled: boolean; callback: () => void }) => {
    if (typeof newParams === 'function') {
      callback = newParams;
      enabled = true;
    } else {
      callback = newParams.callback;
      enabled = newParams.enabled;
    }

    if (enabled && !isListening) {
      document.addEventListener('click', handleClick, true);
      isListening = true;
    } else if (!enabled && isListening) {
      document.removeEventListener('click', handleClick, true);
      isListening = false;
    }
  };

  updateState(params);

  return {
    update(newParams: (() => void) | { enabled: boolean; callback: () => void }) {
      updateState(newParams);
    },
    destroy() {
      if (isListening) {
        document.removeEventListener('click', handleClick, true);
      }
    },
  };
}
