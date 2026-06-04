<script lang="ts">
  import { MonitorX, ArrowLeftRight } from '@lucide/svelte';
  import {
    globalSession as session,
  } from '$lib/stores/globalChatSingleton.svelte';

  /** Ferme l'onglet courant (fonctionne si ouvert programmatiquement, sinon best-effort). */
  function closeThisTab() {
    window.close();
  }

  /** Demande à l'onglet leader de céder le contrôle à cet onglet. */
  function takeOver() {
    session.requestTabTakeover();
  }
</script>

{#if session.isLoggedIn && !session.isTabLeader}
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
      <span class="truncate">
        Messagerie chiffrée active dans un autre onglet.
      </span>
    </div>

    <div class="flex items-center gap-2 flex-shrink-0">
      <button
        type="button"
        onclick={closeThisTab}
        class="text-xs px-2.5 py-1 rounded
               border border-amber-300 dark:border-amber-700
               hover:bg-amber-100 dark:hover:bg-amber-900
               transition-colors"
      >
        Fermer cet onglet
      </button>
      <button
        type="button"
        onclick={takeOver}
        class="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded
               bg-amber-600 hover:bg-amber-700
               text-white transition-colors"
      >
        <ArrowLeftRight size={12} />
        Prendre la main
      </button>
    </div>
  </div>
{/if}
