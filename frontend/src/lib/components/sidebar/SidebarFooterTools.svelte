<script lang="ts">
  import { Download, Upload, ScanLine, Smartphone, Monitor } from 'lucide-svelte';

  interface Props {
    onImport: (file: File) => void;
    onExport: () => void;
    onStartSync: () => void;
    onJoinSync: () => void;
    onOpenDevicePanel: () => void;
    isExporting?: boolean;
    isImporting?: boolean;
    isSyncing?: boolean;
    pendingInvitationCount?: number;
  }

  let {
    onImport,
    onExport,
    onStartSync,
    onJoinSync,
    onOpenDevicePanel,
    isExporting = false,
    isImporting = false,
    isSyncing = false,
    pendingInvitationCount = 0,
  }: Props = $props();

  let fileInput: HTMLInputElement | undefined = $state();

  function triggerImport() {
    fileInput?.click();
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      onImport(file);
      input.value = '';
    }
  }
</script>

<div
  class="p-3 border-t border-white/50 dark:border-white/10 bg-white/25 dark:bg-gray-900/40 backdrop-blur-md"
>
  <div
    class="rounded-2xl border border-white/50 dark:border-white/10 bg-white/35 dark:bg-black/30 p-2.5 shadow-sm"
  >
    <div class="grid grid-cols-5 gap-2">
      <button
        onclick={triggerImport}
        disabled={isImporting}
        class="h-10 rounded-xl bg-white/60 dark:bg-black/30 border border-white/50 dark:border-white/10 text-text-main inline-flex items-center justify-center hover:bg-white/75 dark:hover:bg-black/45 transition-colors disabled:opacity-50"
        title="Importer une sauvegarde"
        aria-label="Importer une sauvegarde"
      >
        <Upload size={16} />
      </button>
      <button
        onclick={onExport}
        disabled={isExporting}
        class="h-10 rounded-xl bg-white/60 dark:bg-black/30 border border-white/50 dark:border-white/10 text-text-main inline-flex items-center justify-center hover:bg-white/75 dark:hover:bg-black/45 transition-colors disabled:opacity-50"
        title="Exporter les conversations"
        aria-label="Exporter les conversations"
      >
        <Download size={16} />
      </button>
      <button
        onclick={onStartSync}
        disabled={isSyncing}
        class="h-10 rounded-xl bg-white/60 dark:bg-black/30 border border-white/50 dark:border-white/10 text-text-main inline-flex items-center justify-center hover:bg-white/75 dark:hover:bg-black/45 transition-colors disabled:opacity-50"
        title="Démarrer une synchronisation QR"
        aria-label="Démarrer une synchronisation QR"
      >
        <ScanLine size={16} />
      </button>
      <button
        onclick={onJoinSync}
        disabled={isSyncing}
        class="h-10 rounded-xl bg-white/60 dark:bg-black/30 border border-white/50 dark:border-white/10 text-text-main inline-flex items-center justify-center hover:bg-white/75 dark:hover:bg-black/45 transition-colors disabled:opacity-50"
        title="Rejoindre une synchronisation QR"
        aria-label="Rejoindre une synchronisation QR"
      >
        <Smartphone size={16} />
      </button>
      <button
        onclick={onOpenDevicePanel}
        class="relative h-10 rounded-xl bg-white/60 dark:bg-black/30 border border-white/50 dark:border-white/10 text-text-main inline-flex items-center justify-center hover:bg-white/75 dark:hover:bg-black/45 transition-colors"
        title="Gérer les appareils"
        aria-label="Gérer les appareils"
      >
        <Monitor size={16} />
        {#if pendingInvitationCount > 0}
          <span
            class="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center px-1 shadow-sm"
          >
            {pendingInvitationCount > 99 ? '99+' : pendingInvitationCount}
          </span>
        {/if}
      </button>
    </div>
  </div>

  <input
    bind:this={fileInput}
    type="file"
    accept=".canari"
    class="hidden"
    onchange={handleFileChange}
  />
</div>
