export function clickOutside(node: HTMLElement, callback: () => void) {
  const handleClick = (event: Event) => {
    if (node && !event.composedPath().includes(node)) {
      callback();
    }
  };
  document.addEventListener('click', handleClick, true);
  return {
    destroy() {
      document.removeEventListener('click', handleClick, true);
    },
  };
}
