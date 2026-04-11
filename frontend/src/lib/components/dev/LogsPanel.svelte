<script lang="ts">
  import { slide } from 'svelte/transition';
  import { Terminal, X, Download } from 'lucide-svelte';
  import { tick } from 'svelte';

  interface Props {
    logs: string[];
    onClose: () => void;
  }

  let { logs, onClose }: Props = $props();

  let logContainer: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (logs.length > 0) {
      tick().then(() => {
        if (logContainer) {
          logContainer.scrollTop = logContainer.scrollHeight;
        }
      });
    }
  });

  // Fonction pour exporter les logs dans un fichier .txt
  function exportLogs() {
    if (logs.length === 0) return;

    const text = logs.join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    // Crée un nom de fichier horodaté, ex: canari-logs-2023-10-25T14-30-00.txt
    a.download = `canari-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

    document.body.appendChild(a);
    a.click();

    // Nettoyage
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
</script>

<!--
  Utilisation de "fixed inset-y-0 right-0" pour le coller en haut, en bas et à droite de l'écran.
  z-[100] garantit qu'il passe par-dessus la bottom bar ou la navbar.
-->
<aside
  class="fixed inset-y-0 right-0 flex flex-col w-[100vw] sm:w-80 xl:w-96 border-l border-black/5 dark:border-white/10 bg-white/70 dark:bg-black/30 backdrop-blur-2xl shadow-[-10px_0_30px_rgba(0,0,0,0.1)] dark:shadow-[-10px_0_30px_rgba(0,0,0,0.3)] z-[100] shrink-0"
  transition:slide={{ axis: 'x', duration: 300, easing: t => t * (2 - t) }}
>
  <!-- Header Glassmorphism -->
  <div class="flex items-center justify-between border-b border-black/5 dark:border-white/10 p-4 bg-white/50 dark:bg-black/40 backdrop-blur-md">
    <h4 class="text-sm font-semibold text-text-main flex items-center gap-2">
      <Terminal size={18} />
      Terminal Système
    </h4>
    <div class="flex items-center gap-1">
      <!-- Bouton d'export -->
      <button
        type="button"
        onclick={exportLogs}
        disabled={logs.length === 0}
        title="Exporter les logs"
        class="rounded-full bg-black/5 dark:bg-white/10 p-2 text-text-main hover:bg-black/10 dark:hover:bg-white/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label="Exporter"
      >
        <Download size={16} />
      </button>

      <!-- Bouton fermer -->
      <button
        type="button"
        onclick={onClose}
        title="Fermer"
        class="rounded-full bg-black/5 dark:bg-white/10 p-2 text-text-main hover:bg-red-500 hover:text-white dark:hover:bg-red-500 transition-colors"
        aria-label="Fermer"
      >
        <X size={16} />
      </button>
    </div>
  </div>

  <!-- Conteneur des Logs (Look Terminal) -->
  <div class="flex-1 p-3 overflow-hidden">
    <div
      bind:this={logContainer}
      class="h-full w-full overflow-y-auto rounded-xl bg-[#0f111a]/95 p-4 shadow-inner ring-1 ring-white/10"
    >
      <div class="font-mono text-[11px] sm:text-xs text-green-400 space-y-1.5 selection:bg-green-400/30">
        {#if logs.length === 0}
          <div class="text-white/40 italic">En attente de journaux...</div>
        {/if}

        {#each logs as entry, i (i)}
          <div class="border-b border-white/5 pb-1.5 break-all opacity-90 hover:opacity-100 transition-opacity">
            <span class="text-blue-400/70 mr-2 font-bold">›</span>{entry}
          </div>
        {/each}
      </div>
    </div>
  </div>
</aside>
