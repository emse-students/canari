/**
 * One choice offered by `Picker.svelte`.
 *
 * The VALUE is what the caller stores and the LABEL is what a person reads - kept apart for the
 * reason `Select.svelte` gives: a screen can offer a sentence while sending an opaque key.
 */
export interface PickerOption {
  /** Stored by the caller; never rendered. */
  value: string;
  /** The line a person reads. */
  label: string;
  /** A second, muted line under the label. */
  description?: string;
  /** Shown but not choosable - a reason the choice exists and is unavailable, e.g. a used slot. */
  disabled?: boolean;
  /**
   * The heading this option sits under. Consecutive options sharing it form one group, so the
   * caller's ORDER decides the grouping - the picker never re-sorts what it was given.
   */
  group?: string;
}

/** A run of consecutive options sharing a heading (`undefined` for an ungrouped run). */
export interface PickerGroup {
  heading?: string;
  options: PickerOption[];
}

/** Splits options into consecutive runs by `group`, keeping the caller's order. */
export function groupPickerOptions(options: PickerOption[]): PickerGroup[] {
  const groups: PickerGroup[] = [];
  for (const option of options) {
    const last = groups.at(-1);
    if (last && last.heading === option.group) last.options.push(option);
    else groups.push({ heading: option.group, options: [option] });
  }
  return groups;
}

/**
 * The index focus moves to for a navigation key, or `null` for any other key.
 *
 * Wraps at both ends, as a native listbox does, so a phone's hardware keyboard and a desktop's reach
 * every option without a dead end.
 */
export function pickerKeyTarget(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
