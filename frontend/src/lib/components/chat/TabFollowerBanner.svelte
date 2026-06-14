<script lang="ts">
  import { MonitorX, ArrowLeftRight } from '@lucide/svelte';
  import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';

  /** Delay before showing the banner, to avoid flicker during the startup leader election. */
  const SHOW_DELAY_MS = 2500;
  let show = $state(false);

  $effect(() => {
    const shouldShow = session.isLoggedIn && !session.isTabLeader;
    if (!shouldShow) {
      show = false;
      return;
    }
    const t = setTimeout(() => (show = true), SHOW_DELAY_MS);
    return () => clearTimeout(t);
  });

  /** Demande à l'onglet leader de céder le contrôle à cet onglet (il se recharge alors en follower). */
  function takeOver() {
    session.requestTabTakeover();
  }
</script>

{#if show}
  <div
    class="flex items-center justify-between gap-3 px-4 py-2.5
           bg-amber-50 dark:bg-amber-950/40
           border-b border-amber-200 dark:border-amber-800
           text-amber-800 dark:text-amber-200
           text-sm"
    role="status"
    aria-live="polite"
  >
    <div class="flex items-center gap-2 min-w-0">
      <MonitorX size={15} class="flex-shrink-0 opacity-70" />
      <span class="truncate"> Messagerie chiffrée active dans un autre onglet. </span>
    </div>

    <button
      type="button"
      onclick={takeOver}
      class="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded shrink-0
             bg-amber-600 hover:bg-amber-700
             text-white transition-colors"
    >
      <ArrowLeftRight size={12} />
      Prendre la main
    </button>
  </div>
{/if}
