<script lang="ts">
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';

  const error = $derived(globalSession.mlsFatalError);

  const config = $derived(
    error === 'oom'
      ? {
          bg: 'bg-red-600',
          text: "Mémoire insuffisante - rechargez l'application pour recevoir de nouveaux messages.",
          action: 'Recharger',
          onAction: () => window.location.reload(),
          dismissible: false,
        }
      : error === 'private_mode'
        ? {
            bg: 'bg-blue-600',
            text: 'Mode navigation privée - les messages ne seront pas conservés après fermeture.',
            action: 'Compris',
            onAction: () => globalSession.clearMlsFatalError(),
            dismissible: true,
          }
        : error === 'keystore_lost'
          ? {
              bg: 'bg-amber-600',
              text: 'Notifications push dégradées - reconnectez-vous pour les réactiver.',
              action: 'Compris',
              onAction: () => globalSession.clearMlsFatalError(),
              dismissible: true,
            }
          : null
  );
</script>

{#if error && config}
  <div
    class="fixed top-[env(safe-area-inset-top)] left-0 right-0 z-50 flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-white {config.bg}"
    role="alert"
  >
    <span class="flex-1">{config.text}</span>
    <button
      type="button"
      class="shrink-0 rounded-md bg-white/20 px-3 py-1 text-xs font-semibold hover:bg-white/30 transition-colors"
      onclick={config.onAction}
    >
      {config.action}
    </button>
  </div>
{/if}
