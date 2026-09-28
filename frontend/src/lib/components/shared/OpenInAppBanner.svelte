<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { Smartphone, X } from '@lucide/svelte';
  import Banner from './Banner.svelte';
  import { openInAppOffer } from '$lib/mobile/openInApp';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * Offers to open the current page in the app, inside the browser built into Messenger, Facebook
   * or Instagram - the one place a Canari link cannot reach the app by itself, because those apps
   * never hand a tapped link to the system (`$lib/mobile/openInApp`).
   *
   * A TAP, never a redirect: without the app installed, a redirect would throw a visitor out of the
   * page they came to read. Dismissed for the rest of the visit, in memory - the in-app browser is
   * thrown away with its tab, so there is nothing a durable flag would remember for.
   */
  let userAgent = $state('');
  let dismissed = $state(false);

  onMount(() => {
    if (!isTauriRuntime()) userAgent = navigator.userAgent;
  });

  const offer = $derived(userAgent ? openInAppOffer(page.url.href, userAgent) : null);

  $effect(() => {
    if (offer) Log.d(`[openInApp] offering the app from an in-app browser (${offer.os})`);
  });
</script>

{#if offer && !dismissed}
  <Banner variant="info">
    <Smartphone size={15} class="shrink-0" aria-hidden="true" />
    <span class="flex min-w-0 flex-col">
      <span>{m.open_in_app_banner_text()}</span>
      <a href={offer.storeHref} class="text-xs underline opacity-80">
        {m.open_in_app_banner_install()}
      </a>
    </span>
    {#snippet action()}
      <div class="flex shrink-0 items-center gap-1">
        <a
          href={offer.openHref}
          class="text-cn-ink rounded-full bg-white px-3 py-1 text-xs font-semibold"
          onclick={() => Log.d(`[openInApp] open tapped (${offer.os})`)}
        >
          {m.open_in_app_banner_open()}
        </a>
        <button
          type="button"
          class="rounded-full p-1 opacity-80 hover:opacity-100"
          aria-label={m.open_in_app_banner_dismiss()}
          onclick={() => (dismissed = true)}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    {/snippet}
  </Banner>
{/if}
