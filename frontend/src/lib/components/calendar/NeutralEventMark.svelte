<script lang="ts">
  import { CalendarDays } from '@lucide/svelte';

  /**
   * THE MARK OF A NEUTRAL "CAMPUS" EVENT: A GENERIC CALENDAR ICON IN A MUTED DISC.
   *
   * A neutral event has no association and no logo by design, and `AssociationAvatar` answers that
   * with initials derived from the name - an orange "CA" that reads as a broken avatar (owner,
   * 2026-11-13). This disc is the same size as the avatar it replaces, in surface tokens only: no
   * accent, nothing derived from the name. It is decorative (`aria-hidden`): the label "Campus" is
   * always drawn beside it, or carried by the enclosing `role="img"`.
   *
   * THE ONE EXCEPTION IS A COLOUR THE BDE CHOSE (owner, 2026-11-14): then the disc wears it, white
   * icon on it like an association's initials, so the chip and the faces match the grid's fill. No
   * choice keeps the muted disc - a colour derived from "Campus" is exactly what this mark refuses.
   */
  interface Props {
    /** `sm` (24 px) in the dense rows and chips, `md` (32 px) in the day panel. */
    size?: 'sm' | 'md';
    /** The owning BDE's `neutralEventColor` (carried by `eventOwners`), or null for the muted disc. */
    color?: string | null;
  }

  let { size = 'sm', color = null }: Props = $props();
</script>

<span
  class="inline-flex shrink-0 items-center justify-center rounded-full {color
    ? 'text-white'
    : 'bg-cn-surface-alt text-text-muted'} {size === 'md' ? 'h-8 w-8' : 'h-6 w-6'}"
  style={color ? `background:${color};` : undefined}
  aria-hidden="true"
  data-neutral-mark
>
  <CalendarDays size={size === 'md' ? 18 : 14} />
</span>
