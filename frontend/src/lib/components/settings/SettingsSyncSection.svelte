<script lang="ts">
  import { RefreshCw, ScanLine, Smartphone, Upload, Download } from '@lucide/svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { useSyncSession } from '$lib/composables/useSyncSession.svelte';
  import SyncSessionModal from '$lib/components/chat/SyncSessionModal.svelte';
  import { m } from '$lib/paraglide/messages';

  // Cross-device conversation transfer (QR) and encrypted .canari file backup/restore.
  const sync = useSyncSession();
  let fileInput: HTMLInputElement | undefined = $state();

  /** Minimal context the sync composable needs to drive a transfer session. */
  function syncCtx() {
    return {
      historyBaseUrl: session.historyBaseUrl,
      userId: session.userId,
      myDeviceId: session.myDeviceId,
      pin: session.pin,
      storage: session.storage,
      log: appendLog,
      loadExistingConversations: async () => {},
      processDeviceInvitationsLocally: async () => {},
    };
  }

  function triggerImport() {
    fileInput?.click();
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      session.handleImport(
        file,
        appendLog,
        () => convs.conversations.clear(),
        async () => {}
      );
      input.value = '';
    }
  }
</script>

<div
  class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200"
  style="animation-fill-mode: backwards;"
>
  <div class="flex items-center gap-3 mb-2">
    <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
      <RefreshCw size={22} strokeWidth={2.5} />
    </div>
    <h2 class="text-lg font-extrabold text-text-main">{m.profile_sync_heading()}</h2>
  </div>
  <p class="text-xs font-medium text-text-muted mb-6 sm:pl-[3.75rem] leading-relaxed">
    {m.profile_sync_desc()}
  </p>

  {#if session.isLoggedIn}
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <button
        type="button"
        onclick={() => sync.handleStartSyncSession(syncCtx())}
        disabled={sync.isSyncSessionBusy}
        class="flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-cn-border bg-white/50 dark:bg-white/5 hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50"
      >
        <ScanLine size={22} class="text-text-muted" />
        <span class="text-sm font-bold text-text-main">{m.profile_sync_transfer_label()}</span>
        <span class="text-[0.7rem] text-text-muted">{m.profile_sync_transfer_sub()}</span>
      </button>

      <button
        type="button"
        onclick={() => sync.openJoinSyncModal()}
        disabled={sync.isSyncSessionBusy}
        class="flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-cn-border bg-white/50 dark:bg-white/5 hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50"
      >
        <Smartphone size={22} class="text-text-muted" />
        <span class="text-sm font-bold text-text-main">{m.profile_sync_scan_label()}</span>
        <span class="text-[0.7rem] text-text-muted">{m.profile_sync_scan_sub()}</span>
      </button>

      <button
        type="button"
        onclick={triggerImport}
        disabled={session.isImporting}
        class="flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-cn-border bg-white/50 dark:bg-white/5 hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50"
      >
        <Upload size={22} class="text-text-muted" />
        <span class="text-sm font-bold text-text-main">{m.profile_sync_import_label()}</span>
        <span class="text-[0.7rem] text-text-muted">{m.profile_sync_import_sub()}</span>
      </button>

      <button
        type="button"
        onclick={() => session.handleExport(appendLog)}
        disabled={session.isExporting}
        class="flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-cn-border bg-white/50 dark:bg-white/5 hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50"
      >
        <Download size={22} class="text-text-muted" />
        <span class="text-sm font-bold text-text-main">{m.profile_sync_export_label()}</span>
        <span class="text-[0.7rem] text-text-muted">{m.profile_sync_export_sub()}</span>
      </button>
    </div>
  {:else}
    <p class="text-sm text-text-muted leading-relaxed">
      {m.profile_sync_locked()}
    </p>
  {/if}
</div>

<input
  bind:this={fileInput}
  type="file"
  accept=".canari"
  class="hidden"
  onchange={handleFileChange}
/>

<SyncSessionModal
  isOpen={sync.isSyncSessionOpen}
  mode={sync.syncMode}
  qrPayload={sync.syncQrPayloadText}
  qrDataUrl={sync.syncQrDataUrl}
  joinPayload={sync.syncJoinPayload}
  statusText={sync.syncStatusText}
  isBusy={sync.isSyncSessionBusy}
  onJoinPayloadChange={(value: string) => (sync.syncJoinPayload = value)}
  onConfirmJoin={() => sync.handleConfirmJoinSync(syncCtx())}
  onCopyPayload={sync.copySyncPayload}
  onClose={sync.closeModal}
/>
