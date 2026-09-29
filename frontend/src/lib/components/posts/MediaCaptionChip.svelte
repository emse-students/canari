<script lang="ts">
  import { Captions } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The "Légende" chip in the corner of a composer thumbnail: it opens THIS media's caption field.
   *
   * WHY A CHIP AND NOT A FIELD UNDER EVERY THUMBNAIL (user, 2026-09-29, on the Mi 9T: *"A-t-on
   * besoin d'un 'Legende (opt.)' ?"*). The composer drew a caption input under each picked file, so
   * a post of four photos carried four empty boxes nobody asked for. A caption is still worth having -
   * the feed prints it under its photo - but it is the exception, so it is ONE field, opened from the
   * photo it belongs to, and the chip turns amber once that photo has one.
   */
  interface Props {
    /** This media already carries a caption. */
    hasCaption: boolean;
    /** Its caption field is the one open under the strip. */
    active: boolean;
    onclick: () => void;
  }

  let { hasCaption, active, onclick }: Props = $props();
</script>

<button
  type="button"
  {onclick}
  aria-pressed={active}
  aria-label={m.post_composer_caption_toggle()}
  class="text-2xs absolute bottom-1 left-1 flex items-center gap-1 rounded-full px-2 py-1 font-bold outline-none before:absolute before:-inset-1.5 before:content-[''] focus-visible:ring-2 focus-visible:ring-amber-400 {active ||
  hasCaption
    ? 'bg-amber-400 text-black'
    : 'bg-black/60 text-white'}"
>
  <Captions size={12} strokeWidth={2.5} />
  {m.post_composer_caption_toggle()}
</button>
