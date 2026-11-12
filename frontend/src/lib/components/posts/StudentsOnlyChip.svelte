<script lang="ts">
  import { GraduationCap } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE "ENTRE ÉTUDIANTS" CHIP (owner, 2026-11-04, decisions 1 and 8): on every card of a post
   * marked so, for every reader - the author, a republisher, a student who will repost it. It is the
   * whole signal: republishing is neither blocked nor warned, so the chip is what tells anyone who
   * passes the post on that its rule travels with it. The title says who may read it.
   */
  interface Props {
    /** Drawn over a video (the reel viewer) rather than on a card's surface. */
    onMedia?: boolean;
  }

  let { onMedia = false }: Props = $props();
</script>

<span
  class="text-2xs inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold {onMedia
    ? 'bg-white/15 text-white'
    : 'bg-amber-warn/10 text-amber-warn-text'}"
  title={m.post_students_only_chip_title()}
  data-students-only-chip
>
  <GraduationCap size={12} strokeWidth={2.5} aria-hidden="true" />
  {m.post_students_only_chip()}
</span>
