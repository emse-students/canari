<script lang="ts">
  import { Download, Upload, ScanLine, Smartphone } from 'lucide-svelte';

  interface Props {
    onImport: (file: File) => void;
    onExport: () => void;
    onStartSync: () => void;
    onJoinSync: () => void;
    isExporting?: boolean;
    isImporting?: boolean;
    isSyncing?: boolean;
  }

  let {
    onImport,
    onExport,
    onStartSync,
    onJoinSync,
    isExporting = false,
    isImporting = false,
    isSyncing = false,
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

<div class="p-3 border-t border-cn-border bg-[var(--surface-elevated)]/95 backdrop-blur-md">
  <div
    class="rounded-2xl border border-cn-border bg-[var(--surface-elevated)] p-3 shadow-sm space-y-3"
  >
    <div class="space-y-2">
      <div class="text-[0.65rem] uppercase tracking-wide font-semibold text-text-muted">
        Sauvegarde chiffree
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button
          onclick={triggerImport}
          disabled={isImporting}
          class="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-xl bg-cn-bg hover:bg-[color-mix(in_srgb,var(--surface-elevated)_75%,transparent)] text-xs font-semibold text-text-main transition-colors disabled:opacity-50"
          title="Importer une sauvegarde .canari"
        >
          <Upload size={13} />
          {isImporting ? 'Import...' : 'Importer'}
        </button>
        <button
          onclick={onExport}
          disabled={isExporting}
          class="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-xl bg-cn-bg hover:bg-[color-mix(in_srgb,var(--surface-elevated)_75%,transparent)] text-xs font-semibold text-text-main transition-colors disabled:opacity-50"
          title="Exporter les conversations vers un fichier .canari"
        >
          <Download size={13} />
          {isExporting ? 'Export...' : 'Exporter'}
        </button>
      </div>
    </div>

    <div class="space-y-2 pt-1 border-t border-cn-border/70">
      <div class="text-[0.65rem] uppercase tracking-wide font-semibold text-text-muted">
        Synchronisation appareils
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button
          onclick={onStartSync}
          disabled={isSyncing}
          class="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-xl bg-cn-bg hover:bg-[color-mix(in_srgb,var(--surface-elevated)_75%,transparent)] text-xs font-semibold text-text-main transition-colors disabled:opacity-50"
          title="Démarrer une session de synchronisation QR"
        >
          <ScanLine size={13} />
          Demarrer
        </button>
        <button
          onclick={onJoinSync}
          disabled={isSyncing}
          class="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-xl bg-cn-bg hover:bg-[color-mix(in_srgb,var(--surface-elevated)_75%,transparent)] text-xs font-semibold text-text-main transition-colors disabled:opacity-50"
          title="Rejoindre une session de synchronisation QR"
        >
          <Smartphone size={13} />
          Joindre
        </button>
      </div>
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
