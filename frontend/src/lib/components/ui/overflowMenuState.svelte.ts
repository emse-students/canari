import { opensAsSheet } from '$lib/components/ui/floatingSurface';

/**
 * THE STATE OF A "..." MENU: whether its `FloatingSurface` is open, in which shape, and the element
 * it hangs from. One implementation for every overflow menu (the profile's, a form row's), so the
 * rule "the shape is decided when the menu OPENS, never while it is open" is written once.
 */
export class OverflowMenuState {
  open = $state(false);
  asSheet = $state(false);
  anchor = $state<HTMLElement | null>(null);

  /** Opens (deciding sheet or popover now) or closes. */
  toggle(): void {
    if (this.open) {
      this.open = false;
      return;
    }
    this.asSheet = opensAsSheet();
    this.open = true;
  }

  /** Closes; `refocus` returns focus to the trigger's button (Escape, a tap on the backdrop). */
  close(refocus = false): void {
    this.open = false;
    if (refocus) this.anchor?.querySelector('button')?.focus();
  }
}
