<script lang="ts">
  import { RefreshCw, Upload, Download } from '@lucide/svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { BackupOutcome } from '$lib/utils/backupOutcome';
  import { backupFileVersion } from '$lib/backup';
  import { copyText } from '$lib/utils/clipboard';
  import { backupOwedAfterKeyMove } from '$lib/crypto/deviceRecoveryCode';

  // Encrypted .canari file backup and restore. Cross-device history is pooled automatically as a
  // manifest diff between the account's own devices (see the chat wiki), so there is nothing here
  // for the user to drive.
  let fileInput: HTMLInputElement | undefined = $state();

  // The one report either operation gets. Until this existed the log sink was the browser console,
  // so a refused file and a restored one looked exactly the same from here: the button went grey,
  // came back, and said nothing.
  let outcome: BackupOutcome | null = $state(null);

  // THE DEVICE'S RECOVERY CODE, SHOWN AFTER EACH EXPORT (2026-10-22): one code for every backup of
  // this device, kept sealed under the device key (`deviceRecoveryCode.ts`). `shownNote` says whether
  // the user already holds it. Dropped from the screen by "I have saved the code" or by leaving.
  let shownCode: string | null = $state(null);
  let shownNote: string | null = $state(null);
  let codeCopied = $state(false);

  // Decision 4 of 2026-10-22: after the move to the hardware-held key, earlier backups no longer
  // open on this phone, so a new one is asked for until it is made. Read again after each export.
  let backupOwed = $derived(session.isLoggedIn && backupOwedAfterKeyMove(session.userId));

  // A v3 file waits here while its code is typed.
  let pendingFile: File | null = $state(null);
  let typedCode = $state('');

  function triggerImport() {
    fileInput?.click();
  }

  async function runImport(file: File, code?: string) {
    outcome = await session.handleImport(
      file,
      appendLog,
      () => convs.conversations.clear(),
      async () => {},
      code
    );
  }

  async function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    // Cleared before the attempt, not after it: leaving the previous verdict on screen while a new
    // import runs is how a failure gets read as belonging to the file just chosen.
    outcome = null;
    input.value = '';
    // The header says whether the file needs its code, so the code is asked BEFORE the import
    // rather than learned from a refusal.
    const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (backupFileVersion(header) === 3) {
      pendingFile = file;
      typedCode = '';
      return;
    }
    await runImport(file);
  }

  async function submitCode() {
    const file = pendingFile;
    if (!file) return;
    pendingFile = null;
    const code = typedCode;
    typedCode = '';
    await runImport(file, code);
  }

  function cancelCode() {
    pendingFile = null;
    typedCode = '';
  }

  async function handleExport() {
    outcome = null;
    shownCode = null;
    codeCopied = false;
    outcome = await session.handleExport(appendLog);
    shownCode = outcome?.recoveryCode ?? null;
    shownNote = outcome?.codeNote ?? null;
    backupOwed = backupOwedAfterKeyMove(session.userId);
  }

  async function copyCode() {
    if (shownCode) codeCopied = await copyText(shownCode, 'backup recovery code');
  }

  function forgetShownCode() {
    shownCode = null;
    shownNote = null;
    codeCopied = false;
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
    <h2 class="text-text-main text-lg font-bold">{m.profile_backup_heading()}</h2>
  </div>
  <p class="text-text-muted mb-6 text-xs leading-relaxed font-medium sm:pl-[3.75rem]">
    {m.profile_backup_desc()}
  </p>

  {#if session.isLoggedIn}
    {#if backupOwed}
      <p
        class="border-cn-yellow/40 bg-cn-yellow/10 text-text-main mb-4 rounded-xl border px-4 py-3 text-sm leading-relaxed font-medium"
        role="status"
        data-testid="backup-owed-after-key-move"
      >
        {m.profile_backup_owed_after_key_move()}
      </p>
    {/if}
    <div class="grid grid-cols-2 gap-3">
      <button
        type="button"
        onclick={triggerImport}
        disabled={session.isImporting}
        class="border-cn-border hover:border-cn-yellow/40 bg-cn-surface flex flex-col items-center gap-2 rounded-2xl border p-4 text-center transition-all active:scale-95 disabled:opacity-50"
      >
        <Upload size={22} class="text-text-muted" />
        <span class="text-text-main text-sm font-bold">{m.profile_backup_import_label()}</span>
        <span class="text-text-muted text-2xs">{m.profile_backup_import_sub()}</span>
      </button>

      <button
        type="button"
        onclick={handleExport}
        disabled={session.isExporting}
        class="border-cn-border hover:border-cn-yellow/40 bg-cn-surface flex flex-col items-center gap-2 rounded-2xl border p-4 text-center transition-all active:scale-95 disabled:opacity-50"
      >
        <Download size={22} class="text-text-muted" />
        <span class="text-text-main text-sm font-bold">{m.profile_backup_export_label()}</span>
        <span class="text-text-muted text-2xs">{m.profile_backup_export_sub()}</span>
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

    {#if shownCode}
      <div class="border-cn-border mt-4 rounded-xl border px-4 py-3" role="region">
        <p class="text-text-main text-sm font-bold">{m.profile_backup_code_title()}</p>
        <p class="text-text-muted mt-1 text-xs leading-relaxed">
          {shownNote ?? m.profile_backup_code_desc()}
        </p>
        <p
          class="text-text-main mt-3 font-mono text-sm font-bold tracking-wide break-all select-all"
          data-testid="backup-recovery-code"
        >
          {shownCode}
        </p>
        <div class="mt-3 flex gap-2">
          <button
            type="button"
            onclick={copyCode}
            class="border-cn-border rounded-xl border px-3 py-2 text-sm font-bold"
          >
            {codeCopied ? m.profile_backup_code_copied() : m.profile_backup_code_copy()}
          </button>
          <button
            type="button"
            onclick={forgetShownCode}
            class="bg-cn-yellow text-cn-dark rounded-xl px-3 py-2 text-sm font-bold"
          >
            {m.profile_backup_code_done()}
          </button>
        </div>
      </div>
    {/if}

    {#if pendingFile}
      <form
        class="border-cn-border mt-4 rounded-xl border px-4 py-3"
        onsubmit={(e) => {
          e.preventDefault();
          void submitCode();
        }}
      >
        <label class="text-text-main text-sm font-bold" for="backup-recovery-code-input">
          {m.profile_backup_code_prompt()}
        </label>
        <input
          id="backup-recovery-code-input"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          bind:value={typedCode}
          placeholder={m.profile_backup_code_placeholder()}
          class="border-cn-border bg-cn-surface text-text-main mt-2 w-full rounded-xl border px-3 py-2 font-mono text-sm"
        />
        <div class="mt-3 flex gap-2">
          <button
            type="button"
            onclick={cancelCode}
            class="border-cn-border rounded-xl border px-3 py-2 text-sm font-bold"
          >
            {m.profile_backup_code_cancel()}
          </button>
          <button
            type="submit"
            disabled={session.isImporting}
            class="bg-cn-yellow text-cn-dark rounded-xl px-3 py-2 text-sm font-bold disabled:opacity-50"
          >
            {m.profile_backup_code_submit()}
          </button>
        </div>
      </form>
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
