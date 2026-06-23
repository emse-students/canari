<script lang="ts">
  import { MonitorX, ArrowLeftRight } from '@lucide/svelte';
  import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
  import { m } from '$lib/paraglide/messages';

  /** Delay before showing the banner, to avoid flicker during the startup leader election. */
  const SHOW_DELAY_MS = 2500;
  let show = $state(false);

  /**
   * True on phone-sized viewports. On mobile a single Canari instance is active at a time,
   * so the "another tab holds the lead" banner is meaningless and must never be shown.
   * (Tauri native apps are always tab leader, so they never reach the banner anyway.)
   */
  let isMobile = $state(false);
  $effect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => (isMobile = mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });

  $effect(() => {
    // Pendant le chargement (isMessagingInitializing) l'election du leader n'est pas encore
    // tranchee : ne rien afficher, sinon la banniere flashe sur l'onglet leader le temps que
    // la connexion s'etablisse. On n'affiche que pour un follower confirme, hors mobile.
    const shouldShow =
      session.isLoggedIn &&
      !session.isMessagingInitializing &&
      !session.isTabLeader &&
      !isMobile;
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
      <span class="truncate"> {m.chat_tab_follower_message()} </span>
    </div>

    <button
      type="button"
      onclick={takeOver}
      class="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded shrink-0
             bg-amber-600 hover:bg-amber-700
             text-white transition-colors"
    >
      <ArrowLeftRight size={12} />
      {m.chat_take_over_button()}
    </button>
  </div>
{/if}
