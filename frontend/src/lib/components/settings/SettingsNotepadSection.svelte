<script lang="ts">
  import { onMount } from 'svelte';
  import { NotebookPen } from '@lucide/svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import { fetchMyNotes, saveMyNotes } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';

  // Private plaintext notepad (server-side, not encrypted). State is owned here so the
  // section is self-contained and can be dropped on any page without wiring.
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
  class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500"
  style="animation-fill-mode: backwards;"
>
  <div class="flex items-center justify-between gap-2 mb-4">
    <h2 class="text-lg font-bold text-text-main flex items-center gap-2">
      <NotebookPen size={20} class="text-cn-dark" />
      {m.profile_notepad_heading()}
    </h2>
    <span class="text-xs text-text-muted">{m.profile_notepad_private()}</span>
  </div>
  {#if noteLoading}
    <p class="text-sm text-text-muted py-3">{m.common_loading_label()}</p>
  {:else}
    <MarkdownComposerField
      bind:value={noteInput}
      placeholder={m.profile_notepad_placeholder()}
      minHeight="140px"
    />
    <div class="flex items-center justify-end gap-3 pt-3">
      {#if noteError}
        <span class="text-xs text-red-600 mr-auto">{noteError}</span>
      {:else if noteSaved}
        <span class="text-xs text-green-600 mr-auto">{m.profile_notepad_saved()}</span>
      {/if}
      <button
        type="button"
        onclick={saveNote}
        disabled={noteSaving}
        class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50 shadow-sm"
      >
        {noteSaving ? m.common_saving_label() : m.common_save_button()}
      </button>
    </div>
  {/if}
</div>
