<script lang="ts">
  import Avatar from '../shared/Avatar.svelte';
  import { connection } from '$lib/stores/slowLink.svelte';
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages';
  import { guideAnchor } from '$lib/guidance/guideAnchors.svelte';

  interface Props {
    userId: string;
    size: 'sm' | 'md';
    /** The box class of the host header (`ui-icon-button` on a phone, `tap-target` on desktop). */
    boxClass: string;
  }

  let { userId, size, boxClass }: Props = $props();

  /**
   * THE CONNECTION RING (owner, 2026-11-11). A TRUE CIRCLE (`rounded-full`, the pill token) hugging
   * the round avatar: the first version rode on a rounded square and read as "a strange square".
   * Green connected, amber slow, grey offline or reconnecting. Written out per state because
   * Tailwind scans source text. The state is also announced by `ConnectionAnnouncer`.
   */
  const RING = {
    connected: 'ring-green-ok',
    slow: 'ring-amber-warn',
    offline: 'ring-text-muted',
    reconnecting: 'ring-text-muted',
  } as const;
  const phase = $derived(connection.state);
  const ringClass = $derived(phase ? RING[phase] : 'ring-transparent');
</script>

<button
  type="button"
  onclick={() => goto('/profile')}
  use:guideAnchor={'nav.profile'}
  title={phase === 'slow' ? m.slow_indicator_label() : m.nav_my_profile_title()}
  aria-label={m.nav_my_profile_label()}
  data-connection={phase ?? undefined}
  class="{boxClass} rounded-full ring-3 transition-all duration-200 {ringClass}"
>
  <Avatar {userId} {size} />
</button>
