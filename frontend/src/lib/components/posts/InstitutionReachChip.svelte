<script lang="ts">
  import { Target } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { carteSpaceLabel } from '$lib/carte/spaceLabel';
  import type { InstitutionReach, InstitutionReachPublic } from '$lib/posts/institutionReach';

  /**
   * THE REACH CHIP (owner, 2026-11-10): on every card of an institution post that carries a reach,
   * for every reader - who it is for (Tous / Étudiants / Personnel) and where (the one space, or how
   * many). The title and the accessible name list every space, so nothing is hidden behind the count.
   */
  interface Props {
    reach: InstitutionReach;
    /** Drawn over a video (the reel viewer) rather than on a card's surface. */
    onMedia?: boolean;
  }

  let { reach, onMedia = false }: Props = $props();

  const publicLabel = (p: InstitutionReachPublic) =>
    p === 'all'
      ? m.post_reach_public_all()
      : p === 'students'
        ? m.post_reach_public_students()
        : m.post_reach_public_staff();

  const spaces = $derived(reach.spaces.map((s) => carteSpaceLabel(s)));
  const where = $derived(
    spaces.length === 1 ? spaces[0] : m.post_reach_chip_spaces({ count: spaces.length })
  );
  const title = $derived(
    m.post_reach_chip_title({ public: publicLabel(reach.public), spaces: spaces.join(', ') })
  );
</script>

<span
  class="text-2xs inline-flex min-w-0 shrink items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold {onMedia
    ? 'bg-white/15 text-white'
    : 'bg-accent/10 text-accent-text'}"
  {title}
  aria-label={title}
  data-institution-reach-chip
>
  <Target size={12} strokeWidth={2.5} aria-hidden="true" class="shrink-0" />
  <span class="truncate"
    >{m.post_reach_chip_label({ public: publicLabel(reach.public), where })}</span
  >
</span>
