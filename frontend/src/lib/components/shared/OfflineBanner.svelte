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

  /*
   * The third state, a slow link (WP-OFF-5), is NOT drawn here: it is an amber ring around the
   * header avatar (`slowLink`, announced by `SlowLinkAnnouncer`). A floating badge read as a
   * smudge over that avatar (owner, 2026-10-31).
   */
</script>

{#if show}
  <Banner busy={reconnecting}>
    {#if reconnecting}
      <RefreshCw
        size={14}
        class="shrink-0 opacity-70 motion-safe:animate-spin"
        aria-hidden="true"
      />
      <span class="truncate">{m.offline_banner_reconnecting()}</span>
    {:else}
      <CloudOff size={14} class="shrink-0 opacity-70" aria-hidden="true" />
      <!-- A FEW WORDS ON SCREEN, THE SENTENCE FOR THE EAR. What the offline state means (reading
           works, messages queue, a salon's media waits) is on the wiki and read out by the live
           region, not drawn: the owner asked for the minimum (2026-11-09). -->
      <span class="truncate font-semibold" title={m.offline_banner_desc()}>
        {m.offline_banner_title()}
      </span>
      <span class="sr-only">{m.offline_banner_desc()}</span>
    {/if}
  </Banner>
{/if}
