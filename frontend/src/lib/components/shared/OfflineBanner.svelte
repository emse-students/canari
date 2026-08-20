<script lang="ts">
  import { CloudOff, RefreshCw } from '@lucide/svelte';
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
</script>

{#if show}
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
