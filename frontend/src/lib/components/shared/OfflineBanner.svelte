<script lang="ts">
  import { CloudOff, RefreshCw, SignalLow } from '@lucide/svelte';
  import Banner from './Banner.svelte';
  import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
  import { connectivity } from '$lib/stores/connectivity.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * Shown while the app is usable but cut off from the server: history reads from the local
   * encrypted store and new messages queue in the outbox.
   *
   * Deliberately NOT driven by `isWsConnected`. A dropped socket on an authenticated session is a
   * transient the reconnect watchdog already owns, and flagging it as "offline" would cry wolf
   * several times an hour on a mobile network. The two facts worth surfacing are: the transport is
   * down (`connectivity.isOffline`), or the session itself never got a token
   * (`session.isOfflineSession`, an offline unlock awaiting promotion).
   */
  let show = $derived(session.isLoggedIn && (connectivity.isOffline || session.isOfflineSession));

  /**
   * True once the browser believes it has a link again but the session has not been promoted yet -
   * the short window in which the token is being reissued and the socket reopened.
   */
  let reconnecting = $derived(!connectivity.isOffline && session.isOfflineSession);

  /**
   * The third state (WP-OFF-5): answers are arriving, slowly. A small discreet icon, no strip (user,
   * 2026-10-11: the band was too present, and not always justified) - nothing is disabled,
   * because a slow link is not an offline one and the queue is still sending. Derived from observed answer latency, never from a timer that guesses (see
   * `connectivity.slow`), and never shown on top of the offline banner.
   */
  let showSlow = $derived(session.isLoggedIn && !show && connectivity.slow);
</script>

{#if showSlow}
  <!-- A hint, not a banner: a fixed 20 px badge in the top corner, so it takes no band of the screen
       and shifts nothing. Never focusable and never intercepting a tap (`pointer-events-none`); the
       text lives in the live region and in `title` for a pointer hover.
       BELOW THE BANNER COLUMN, through `--app-banner-height`: being `fixed`, it reserves nothing and
       learns nothing of the column it is rendered in, so at a bare `top` it was drawn over the dev
       "Environnement de test" strip and its close button (Mi 9T reading of `v1.2.4-alpha.2`). -->
  <div
    class="bg-banner text-text-muted border-cn-border pointer-events-none fixed top-[calc(var(--safe-area-inset-top,0px)+var(--app-banner-height,0px)+0.5rem)] right-2 z-(--z-banner) flex size-7 items-center justify-center rounded-full border opacity-80"
    role="status"
    aria-live="polite"
    aria-label={m.slow_indicator_label()}
    title={m.slow_indicator_label()}
    data-testid="slow-link-indicator"
  >
    <SignalLow size={16} aria-hidden="true" />
  </div>
{:else if show}
  <Banner busy={reconnecting}>
    {#if reconnecting}
      <RefreshCw size={15} class="shrink-0 animate-spin opacity-70" aria-hidden="true" />
      <span class="truncate">{m.offline_banner_reconnecting()}</span>
    {:else}
      <CloudOff size={15} class="shrink-0 opacity-70" aria-hidden="true" />
      <!-- Spacing via gap rather than markup whitespace: the gap survives any reformatting of
           the two message spans, a literal space between them does not. -->
      <span class="flex min-w-0 flex-wrap gap-x-1">
        <span class="font-semibold">{m.offline_banner_title()}</span>
        <span class="opacity-80">{m.offline_banner_desc()}</span>
      </span>
    {/if}
  </Banner>
{/if}
