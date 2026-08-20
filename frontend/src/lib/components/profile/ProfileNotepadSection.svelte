<script lang="ts">
  import { onMount } from 'svelte';
  import { NotebookPen } from '@lucide/svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import { trimComposerText } from '$lib/utils/markdown/composerText';
  import { fetchMyNotes, saveMyNotes } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';

  // Private notepad, encrypted client-side under a per-user key (see `saveMyNotes`).
  // State is owned here so the section is self-contained and can be dropped on any
  // page without wiring.
  let noteInput = $state('');
  let noteLoading = $state(true);
  let noteSaving = $state(false);
  let noteSaved = $state(false);
  let noteError = $state('');

  onMount(loadMyNotes);

  async function loadMyNotes() {
    noteLoading = true;
    try {
      noteInput = await fetchMyNotes();
    } catch {
      noteError = m.profile_notepad_load_error();
    } finally {
      noteLoading = false;
    }
  }

  async function saveNote() {
    noteSaving = true;
    noteError = '';
    noteSaved = false;
    try {
      noteInput = trimComposerText(noteInput);
      await saveMyNotes(noteInput);
      noteSaved = true;
      setTimeout(() => (noteSaved = false), 2000);
    } catch {
      noteError = m.profile_notepad_save_error();
    } finally {
      noteSaving = false;
    }
  }
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="mb-4 flex items-center justify-between gap-2">
    <h2 class="text-text-main flex items-center gap-2 text-lg font-bold">
      <NotebookPen size={20} class="text-cn-dark" />
      {m.profile_notepad_heading()}
    </h2>
    <span class="text-text-muted text-xs">{m.profile_notepad_private()}</span>
  </div>
  {#if noteLoading}
    <p class="text-text-muted py-3 text-sm">{m.common_loading_label()}</p>
  {:else}
    <MarkdownComposerField
      bind:value={noteInput}
      placeholder={m.profile_notepad_placeholder()}
      minHeight="140px"
      class="focus-within:border-cn-yellow/50 focus-within:ring-cn-yellow/30 w-full min-w-0 overflow-hidden rounded-[1.25rem] border border-black/10 bg-white/80 shadow-inner transition-all focus-within:ring-2 dark:border-white/10 dark:bg-black/40"
      editorClass="min-h-[140px] w-full max-w-full px-4 py-3 text-[0.95rem] text-text-main leading-relaxed"
    />
    <div class="flex items-center justify-end gap-3 pt-3">
      {#if noteError}
        <span class="text-red-err mr-auto text-xs">{noteError}</span>
      {:else if noteSaved}
        <span class="text-green-ok mr-auto text-xs">{m.profile_notepad_saved()}</span>
      {/if}
      <button
        type="button"
        onclick={saveNote}
        disabled={noteSaving}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm disabled:opacity-50"
      >
        {noteSaving ? m.common_saving_label() : m.common_save_button()}
      </button>
    </div>
  {/if}
</div>
