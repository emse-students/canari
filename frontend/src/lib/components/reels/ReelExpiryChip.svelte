<script lang="ts">
  /**
   * How long one of the member's reels has left before the server deletes it (C6), on the server's
   * clock (`myReels`). Amber once the server says it is expiring soon, so the save is not missed.
   * Only the author sees it: nobody else's reel is in their `my-reels` list.
   */
  import { Clock } from '@lucide/svelte';
  import type { MyReel } from '$lib/posts/api';
  import { myReels } from '$lib/reels/myReels.svelte';
  import { m } from '$lib/paraglide/messages';

  let { reel }: { reel: MyReel } = $props();

  const days = $derived(myReels.daysLeft(reel));
  const label = $derived(days < 1 ? m.reels_expires_today() : m.reels_expires_in({ days }));
</script>

<span
  class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold {reel.expiringSoon
    ? 'text-cn-ink bg-amber-500'
    : 'bg-black/50 text-white'}"
  data-reel-expiry={days}
>
  <Clock size={12} strokeWidth={2.5} />
  {label}
</span>
