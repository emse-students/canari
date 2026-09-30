<script lang="ts">
  import { FlaskConical, X } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import Banner from './Banner.svelte';
  import { isNonProductionDeployment } from '$lib/utils/deployEnvironment';
  import { Log } from '$lib/utils/Log';

  /**
   * DISMISSIBLE FOR THE SESSION ONLY, AND THE WHY OF BOTH HALVES. The dev environment carries a FULL
   * copy of production's database, so it is indistinguishable from production on screen - the same
   * members, the same communities, the same posts. Somebody who forgets which one they are in will
   * post to what looks like the real thing. That is why it was permanent.
   *
   * The user overruled that on 2026-09-30 after walking the iPhone build: on a phone the strip
   * costs ~180 px on every screen, which makes the test build unusable to test. So it closes - but
   * into `sessionStorage`, not `localStorage`: it comes back at every launch of the app or tab, so
   * "closed on the first session and never seen again" (the failure the permanence guarded against)
   * cannot happen.
   *
   * It is a BUILD-TIME fact, so it is up before the first request and stays up when the API is
   * unreachable - see `deployEnvironment.ts` for why it is neither an API call nor a hostname check.
   */
  const STORAGE_KEY = 'canari_env_banner_dismissed';

  function readDismissed(): boolean {
    try {
      return sessionStorage.getItem(STORAGE_KEY) === '1';
    } catch (e) {
      // Storage can be blocked (private window): the banner then simply stays up, the safe side.
      Log.d('EnvironmentBanner: sessionStorage unreadable, banner stays up', e);
      return false;
    }
  }

  let dismissed = $state(readDismissed());
  const show = isNonProductionDeployment();

  function dismiss() {
    Log.d('EnvironmentBanner: dismissed for this session');
    dismissed = true;
    try {
      sessionStorage.setItem(STORAGE_KEY, '1');
    } catch (e) {
      Log.d('EnvironmentBanner: sessionStorage unwritable, dismissal is this render only', e);
    }
  }
</script>

{#if show && !dismissed}
  <!-- No placement of its own: `+layout.svelte` stacks the window-scale banners in one fixed column.
       It is FIRST in that column deliberately - the others come and go, this one is a property of
       the whole deployment, so it must not be pushed off screen by a transient notice. -->
  <Banner variant="info" center class="font-bold">
    <FlaskConical size={14} aria-hidden="true" />
    <span>
      {m.env_banner_test_label()}
      <span class="font-normal">{m.env_banner_test_detail()}</span>
    </span>
    {#snippet action()}
      <button
        type="button"
        class="-mr-2 grid size-8 shrink-0 place-items-center rounded-full pointer-coarse:size-11"
        aria-label={m.common_close_label()}
        onclick={dismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    {/snippet}
  </Banner>
{/if}
