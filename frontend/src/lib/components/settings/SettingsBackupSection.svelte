<script lang="ts">
  import { RefreshCw, Upload, Download } from '@lucide/svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { BackupOutcome } from '$lib/utils/backupOutcome';

  // Encrypted .canari file backup and restore. Cross-device history is pooled automatically as a
  // manifest diff between the account's own devices (see the chat wiki), so there is nothing here
  // for the user to drive.
  let fileInput: HTMLInputElement | undefined = $state();

  // The one report either operation gets. Until this existed the log sink was the browser console,
  // so a refused file and a restored one looked exactly the same from here: the button went grey,
  // came back, and said nothing.
  let outcome: BackupOutcome | null = $state(null);

  function triggerImport() {
    fileInput?.click();
  }

  async function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    // Cleared before the attempt, not after it: leaving the previous verdict on screen while a new
    // import runs is how a failure gets read as belonging to the file just chosen.
    outcome = null;
    input.value = '';
    outcome = await session.handleImport(
      file,
      appendLog,
      () => convs.conversations.clear(),
      async () => {}
    );
  }

  async function handleExport() {
    outcome = null;
    outcome = await session.handleExport(appendLog);
  }
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-200 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="mb-2 flex items-center gap-3">
    <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
      <RefreshCw size={22} strokeWidth={2.5} />
    </div>
    <h2 class="text-text-main text-lg font-extrabold">{m.profile_backup_heading()}</h2>
  </div>
  <p class="text-text-muted mb-6 text-xs leading-relaxed font-medium sm:pl-[3.75rem]">
    {m.profile_backup_desc()}
  </p>

  {#if session.isLoggedIn}
    <div class="grid grid-cols-2 gap-3">
      <button
        type="button"
        onclick={triggerImport}
        disabled={session.isImporting}
        class="border-cn-border hover:border-cn-yellow/40 flex flex-col items-center gap-2 rounded-2xl border bg-white/50 p-4 text-center transition-all active:scale-95 disabled:opacity-50 dark:bg-white/5"
      >
        <Upload size={22} class="text-text-muted" />
        <span class="text-text-main text-sm font-bold">{m.profile_backup_import_label()}</span>
        <span class="text-text-muted text-[0.7rem]">{m.profile_backup_import_sub()}</span>
      </button>

      <button
        type="button"
        onclick={handleExport}
        disabled={session.isExporting}
        class="border-cn-border hover:border-cn-yellow/40 flex flex-col items-center gap-2 rounded-2xl border bg-white/50 p-4 text-center transition-all active:scale-95 disabled:opacity-50 dark:bg-white/5"
      >
        <Download size={22} class="text-text-muted" />
        <span class="text-text-main text-sm font-bold">{m.profile_backup_export_label()}</span>
        <span class="text-text-muted text-[0.7rem]">{m.profile_backup_export_sub()}</span>
      </button>
    </div>

    {#if outcome}
      <p
        class="mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed font-medium {outcome.ok
          ? 'border-cn-border text-text-main'
          : 'border-red-err/30 bg-red-err/10 text-red-err'}"
        role="status"
        aria-live="polite"
      >
        {outcome.text}
      </p>
    {/if}
  {:else}
    <p class="text-text-muted text-sm leading-relaxed">
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
