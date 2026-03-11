<script lang="ts">
  import { Copy, QrCode, Smartphone, Loader2, X } from 'lucide-svelte';

  interface Props {
    isOpen: boolean;
    mode: 'offer' | 'join';
    qrPayload: string;
    joinPayload: string;
    statusText: string;
    isBusy: boolean;
    onJoinPayloadChange: (value: string) => void;
    onConfirmJoin: () => void;
    onCopyPayload: () => void;
    onClose: () => void;
  }

  let {
    isOpen,
    mode,
    qrPayload,
    joinPayload,
    statusText,
    isBusy,
    onJoinPayloadChange,
    onConfirmJoin,
    onCopyPayload,
    onClose,
  }: Props = $props();
</script>

{#if isOpen}
  <button
    class="fixed inset-0 z-[70] bg-black/40 border-0"
    aria-label="Fermer la fenêtre de synchronisation"
    onclick={onClose}
  ></button>

  <section
    class="fixed z-[80] inset-x-3 top-10 md:inset-x-auto md:right-8 md:top-20 md:w-[34rem] bg-[var(--cn-surface)] border border-cn-border rounded-2xl shadow-2xl p-4 md:p-5 flex flex-col gap-3"
  >
    <div class="flex items-center justify-between">
      <h3 class="text-base font-semibold text-cn-dark inline-flex items-center gap-2">
        {#if mode === 'offer'}
          <QrCode size={18} /> Synchronisation: appareil source
        {:else}
          <Smartphone size={18} /> Synchronisation: appareil cible
        {/if}
      </h3>
      <button
        class="p-1.5 rounded-lg text-gray-500 hover:bg-cn-bg"
        onclick={onClose}
        aria-label="Fermer"
      >
        <X size={16} />
      </button>
    </div>

    {#if mode === 'offer'}
      <p class="text-sm text-gray-600">
        Scannez ce payload QR avec l'autre appareil, puis attendez la fin de la synchronisation.
      </p>
      <textarea
        readonly
        value={qrPayload}
        rows="5"
        class="w-full text-xs font-mono px-3 py-2 border border-cn-border rounded-xl bg-cn-bg text-cn-dark"
      ></textarea>
      <button
        onclick={onCopyPayload}
        class="w-full px-3 py-2 rounded-xl bg-cn-dark text-white inline-flex items-center justify-center gap-2"
      >
        <Copy size={14} /> Copier le payload
      </button>
    {:else}
      <p class="text-sm text-gray-600">
        Collez ici le payload obtenu après scan du QR sur l'appareil source.
      </p>
      <textarea
        value={joinPayload}
        rows="5"
        oninput={(e) => onJoinPayloadChange(e.currentTarget.value)}
        placeholder="Collez ici le payload JSON de synchronisation"
        class="w-full text-xs font-mono px-3 py-2 border border-cn-border rounded-xl bg-cn-bg text-cn-dark"
      ></textarea>
      <button
        onclick={onConfirmJoin}
        disabled={isBusy || !joinPayload.trim()}
        class="w-full px-3 py-2 rounded-xl bg-cn-dark text-white inline-flex items-center justify-center gap-2 disabled:opacity-50"
      >
        {#if isBusy}
          <Loader2 size={14} class="animate-spin" />
        {/if}
        Lancer la synchronisation
      </button>
    {/if}

    {#if statusText}
      <div class="text-xs text-gray-600 bg-cn-bg border border-cn-border rounded-lg px-3 py-2">
        {statusText}
      </div>
    {/if}
  </section>
{/if}
