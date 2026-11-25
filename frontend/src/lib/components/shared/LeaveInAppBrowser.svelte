<script lang="ts">
  import { onMount } from 'svelte';
  import { ExternalLink, Smartphone, Copy } from '@lucide/svelte';
  import { exitHref } from '$lib/leaveInAppBrowser/detect';
  import type { InAppBrowserGuard } from '$lib/mobile/inAppBrowserGuard';
  import { iosAppOpenHref } from '$lib/mobile/openInApp';
  import { Log } from '$lib/utils/Log';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE WAY OUT, drawn in place of the whole app when `inAppBrowserGuard` holds (owner decision of
   * 2026-11-25; why that guard is load-bearing is in its module). Same doors as the server's
   * interstitial (`exitHref`), the same single attempt on mount with no timer, the same buttons; its
   * strings are Paraglide's, as everywhere in the app. The address is the guard's capture, taken
   * before anything could move the page. docs/wiki/frontend/leaving-in-app-browsers.md.
   */
  let { guard }: { guard: InAppBrowserGuard } = $props();

  const browser = $derived(guard.browser);
  const href = $derived(guard.href);
  const exit = $derived(exitHref(browser, href));
  const appHref = $derived(browser.os === 'ios' ? iosAppOpenHref(new URL(href)) : null);
  let copy = $state<'idle' | 'copied' | 'failed'>('idle');
  const LINK_FIELD_ID = 'leave-iab-link';

  onMount(() => {
    // ONE ATTEMPT, NO TIMER: if the in-app browser refuses, this screen is the end state. The guard
    // already logged the visit at warn.
    if (exit) window.location.href = exit;
  });

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(href);
      copy = 'copied';
    } catch (error) {
      Log.d('leaveInAppBrowser', `clipboard refused: ${String(error)}`);
      copy = 'failed';
      // The link is selected for a manual copy (`Input` keeps its element to itself).
      (document.getElementById(LINK_FIELD_ID) as HTMLInputElement | null)?.select();
    }
  }
</script>

<main
  class="bg-cn-bg text-text-main flex min-h-dvh items-center justify-center p-4"
  aria-labelledby="leave-iab-title"
>
  <section class="bg-cn-card border-cn-border w-full max-w-md rounded-2xl border p-6">
    <p class="text-text-muted mb-2 text-sm break-all">{new URL(href).host}</p>
    <h1 id="leave-iab-title" class="mb-3 text-xl font-bold">{m.leave_iab_title()}</h1>
    <p class="mb-4">{m.leave_iab_text()}</p>
    {#if exit}
      <Button href={exit} variant="primary" class="mb-3 w-full">
        <ExternalLink size={18} aria-hidden="true" />
        {browser.os === 'ios' ? m.leave_iab_open_safari() : m.leave_iab_open_browser()}
      </Button>
    {/if}
    {#if appHref}
      <Button href={appHref} variant="secondary" class="mb-3 w-full">
        <Smartphone size={18} aria-hidden="true" />
        {m.leave_iab_open_app()}
      </Button>
    {/if}
    <p class="text-text-muted mb-4">
      {browser.os === 'android' ? m.leave_iab_manual_android() : m.leave_iab_manual_ios()}
    </p>
    <Input id={LINK_FIELD_ID} label={m.leave_iab_link_label()} value={href} readonly class="mb-3" />
    <Button variant="secondary" onclick={copyLink} class="mb-2 w-full">
      <Copy size={18} aria-hidden="true" />
      {m.leave_iab_copy()}
    </Button>
    <p role="status" aria-live="polite" class="text-text-muted min-h-6">
      {#if copy === 'copied'}{m.leave_iab_copied()}{:else if copy === 'failed'}{m.leave_iab_copy_failed()}{/if}
    </p>
  </section>
</main>
