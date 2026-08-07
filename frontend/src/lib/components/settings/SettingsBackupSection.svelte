<script lang="ts">
  import { RefreshCw, Upload, Download } from '@lucide/svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { m } from '$lib/paraglide/messages';

  // Encrypted .canari file backup and restore. Cross-device history is pooled automatically as a
  // manifest diff between the account's own devices (see the chat wiki), so there is nothing here
  // for the user to drive.
  let fileInput: HTMLInputElement | undefined = $state();

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
    <h2 class="text-lg font-extrabold text-text-main">{m.profile_backup_heading()}</h2>
  </div>
  <p class="text-xs font-medium text-text-muted mb-6 sm:pl-[3.75rem] leading-relaxed">
    {m.profile_backup_desc()}
  </p>

  {#if session.isLoggedIn}
    <div class="grid grid-cols-2 gap-3">
      <button
        type="button"
        onclick={triggerImport}
        disabled={session.isImporting}
        class="flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-cn-border bg-white/50 dark:bg-white/5 hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50"
      >
        <Upload size={22} class="text-text-muted" />
        <span class="text-sm font-bold text-text-main">{m.profile_backup_import_label()}</span>
        <span class="text-[0.7rem] text-text-muted">{m.profile_backup_import_sub()}</span>
      </button>

      <button
        type="button"
        onclick={() => session.handleExport(appendLog)}
        disabled={session.isExporting}
        class="flex flex-col items-center text-center gap-2 p-4 rounded-2xl border border-cn-border bg-white/50 dark:bg-white/5 hover:border-cn-yellow/40 transition-all active:scale-95 disabled:opacity-50"
      >
        <Download size={22} class="text-text-muted" />
        <span class="text-sm font-bold text-text-main">{m.profile_backup_export_label()}</span>
        <span class="text-[0.7rem] text-text-muted">{m.profile_backup_export_sub()}</span>
      </button>
    </div>
  {:else}
    <p class="text-sm text-text-muted leading-relaxed">
      {m.profile_backup_locked()}
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
