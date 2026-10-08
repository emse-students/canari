<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { Smartphone } from '@lucide/svelte';
  import { openInAppOffer } from '$lib/mobile/openInApp';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * Pushes the visitor out of the browser built into Messenger, Facebook or Instagram and into the
   * app - the one place a Canari link cannot reach the app by itself, because those apps never hand
   * a tapped link to the system (`$lib/mobile/openInApp`). Nobody should stay in that browser, so
   * this is a large card with ONE obvious button, not a strip with a small link (user, 2026-10-08).
   *
   * A TAP, never a redirect: without the app installed, a redirect would throw a visitor out of the
   * page they came to read. The way to stay is a plain text link, deliberately the quietest thing on
   * the card. Dismissed for the rest of the visit, in memory - the in-app browser is thrown away
   * with its tab, so there is nothing a durable flag would remember for.
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
  <section
    class="bg-banner-info m-3 flex flex-col items-center gap-3 rounded-2xl p-5 text-center text-white shadow-lg"
    aria-label={m.open_in_app_banner_title()}
  >
    <span class="flex size-14 items-center justify-center rounded-full bg-white/20">
      <Smartphone size={30} aria-hidden="true" />
    </span>
    <h2 class="text-xl font-bold">{m.open_in_app_banner_title()}</h2>
    <p class="max-w-sm text-base opacity-95">{m.open_in_app_banner_text()}</p>
    <a
      href={offer.openHref}
      class="text-cn-ink w-full max-w-sm rounded-full bg-white px-6 py-3.5 text-base font-bold shadow-md"
      onclick={() => Log.d(`[openInApp] open tapped (${offer.os})`)}
    >
      {m.open_in_app_banner_open()}
    </a>
    <a href={offer.storeHref} class="text-sm font-medium underline">
      {m.open_in_app_banner_install()}
    </a>
    <button
      type="button"
      class="text-sm underline opacity-70 hover:opacity-100"
      onclick={() => (dismissed = true)}
    >
      {m.open_in_app_banner_dismiss()}
    </button>
  </section>
{/if}
