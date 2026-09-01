<script lang="ts">
  import { FlaskConical } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import Banner from './Banner.svelte';
  import { isNonProductionDeployment } from '$lib/utils/deployEnvironment';

  /**
   * PERMANENT, AND NOT DISMISSIBLE, AND THAT IS THE POINT. The dev environment carries a FULL copy
   * of production's database, so it is indistinguishable from production on screen - the same
   * members, the same communities, the same posts. Somebody who forgets which one they are in will
   * post to what looks like the real thing, or read a real conversation and act on it. A banner that
   * could be closed would be closed on the first session and never seen again.
   *
   * It is a BUILD-TIME fact, so it is up before the first request and stays up when the API is
   * unreachable - see `deployEnvironment.ts` for why it is neither an API call nor a hostname check.
   */
  const show = isNonProductionDeployment();
</script>

{#if show}
  <!-- No placement of its own: `+layout.svelte` stacks the window-scale banners in one fixed column.
       It is FIRST in that column deliberately - the others come and go, this one is a property of
       the whole deployment, so it must not be pushed off screen by a transient notice. -->
  <Banner variant="info" center class="font-bold">
    <FlaskConical size={14} aria-hidden="true" />
    <span>
      {m.env_banner_test_label()}
      <span class="font-normal">{m.env_banner_test_detail()}</span>
    </span>
  </Banner>
{/if}
