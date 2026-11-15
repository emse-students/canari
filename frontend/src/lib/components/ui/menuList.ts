import type { Component } from 'svelte';

/** One entry of a `MenuList`: an icon on the left, a left-aligned label, an optional muted line. */
interface MenuListItem {
  /** Handed back to `onSelect`; unique within the list. */
  key: string;
  label: string;
  /** One short muted line under the label. */
  description?: string;
  Icon?: Component<any>;
  /** The current choice: tinted, with a check on the right. */
  selected?: boolean;
  /** A destructive action, drawn in the error colour. */
  danger?: boolean;
}

/** A titled run of entries of a `MenuList`. */
export interface MenuListSection {
  /** A small title above the section; a section without one follows a divider. */
  title?: string;
  items: MenuListItem[];
}
