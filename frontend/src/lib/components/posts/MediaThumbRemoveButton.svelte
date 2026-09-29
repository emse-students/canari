<script lang="ts">
  import { X } from '@lucide/svelte';

  /**
   * The "remove" cross on a media thumbnail in the post composer and editor.
   *
   * SMALL TO SEE, LARGE TO HIT. It was a `ui-icon-button`, whose coarse-pointer minimum is a full
   * touch target: on a 7rem thumbnail that drew a dark disc over half the photo (Mi 9T,
   * 2026-09-29). The visible circle is now 1.75rem and a transparent `::before` extends the hit
   * area by 0.5rem on every side, so a thumb still lands on it. Always visible - a phone has no
   * hover to reveal it.
   */
  interface Props {
    label: string;
    title?: string;
    onclick: () => void;
  }

  let { label, title, onclick }: Props = $props();
</script>

<button
  type="button"
  {onclick}
  aria-label={label}
  {title}
  class="absolute top-1 right-1 flex size-7 items-center justify-center rounded-full bg-black/60 text-white outline-none before:absolute before:-inset-2 before:content-[''] hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-400"
>
  <X size={14} strokeWidth={2.5} />
</button>
