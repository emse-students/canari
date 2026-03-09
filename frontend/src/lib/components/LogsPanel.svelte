<script lang="ts">
  import { slide } from 'svelte/transition';
  import { X } from 'lucide-svelte';
  import { tick } from 'svelte';

  interface Props {
    logs: string[];
    onClose: () => void;
    onGenerateKeyPackage?: () => void;
    onAddMember?: () => void;
    onProcessWelcome?: () => void;
    lastKeyPackage?: string;
    lastCommit?: string;
    lastWelcome?: string;
    incomingBytesHex?: string;
    onIncomingBytesChange?: (value: string) => void;
  }

  let {
    logs,
    onClose,
    onGenerateKeyPackage,
    onAddMember,
    onProcessWelcome,
    lastKeyPackage = '',
    lastCommit: _lastCommit = '',
    lastWelcome: _lastWelcome = '',
    incomingBytesHex = '',
    onIncomingBytesChange,
  }: Props = $props();

  let logContainer: HTMLDivElement;

  $effect(() => {
    if (logs.length > 0) {
      tick().then(() => {
        if (logContainer) {
          logContainer.scrollTop = logContainer.scrollHeight;
        }
      });
    }
  });
</script>

<aside
  class="w-full h-full md:w-80 bg-slate-900 text-green-400 flex flex-col border-l border-slate-800"
  transition:slide={{ axis: 'x' }}
>
  <!-- Header -->
  <div class="px-4 py-4 bg-slate-800 flex justify-between items-center text-white">
    <h4 class="text-sm font-bold uppercase tracking-wider">Terminal Système</h4>
    <button onclick={onClose} class="text-gray-400 hover:text-white text-xl">
      <X size={20} />
    </button>
  </div>

  <!-- Logs -->
  <div
    bind:this={logContainer}
    class="flex-1 overflow-y-auto px-4 py-4 font-mono text-xs space-y-1"
  >
    {#each logs as entry, i (i)}
      <div class="border-b border-white/5 pb-1 break-all">{entry}</div>
    {/each}
  </div>

  <!-- Dev Tools -->
  {#if onGenerateKeyPackage || onAddMember || onProcessWelcome}
    <details class="bg-slate-800 border-t border-slate-700 text-white text-sm">
      <summary class="px-4 py-4 cursor-pointer font-bold">Outils Développeur</summary>
      <div class="px-4 pb-4 space-y-2">
        {#if onGenerateKeyPackage}
          <button
            onclick={onGenerateKeyPackage}
            class="w-full py-2 px-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors"
          >
            Générer KeyPackage
          </button>
        {/if}

        {#if lastKeyPackage}
          <input
            type="text"
            readonly
            value={lastKeyPackage}
            class="w-full bg-slate-900 text-white border border-slate-600 px-2 py-2 rounded-lg font-mono text-xs"
          />
        {/if}

        {#if onIncomingBytesChange}
          <input
            type="text"
            value={incomingBytesHex}
            oninput={(e) => onIncomingBytesChange?.(e.currentTarget.value)}
            placeholder="Payload Hex..."
            class="w-full bg-slate-900 text-white border border-slate-600 px-2 py-2 rounded-lg outline-none font-mono text-xs"
          />
        {/if}

        {#if onAddMember}
          <button
            onclick={onAddMember}
            class="w-full py-2 px-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors"
          >
            Ajouter Membre
          </button>
        {/if}

        {#if onProcessWelcome}
          <button
            onclick={onProcessWelcome}
            class="w-full py-2 px-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors"
          >
            Traiter Welcome
          </button>
        {/if}
      </div>
    </details>
  {/if}
</aside>
