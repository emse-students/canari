<script lang="ts">
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the edit form is currently shown. */
    editing: boolean;
    /** Current value of the edit textarea. */
    editText: string;
    /** Called on every keystroke with the updated textarea value. */
    onEditChange?: (text: string) => void;
    /** Called when the user clicks "Enregistrer" or presses Ctrl+Enter. */
    onConfirm?: () => void;
    /** Called when the user clicks "Annuler" or presses Escape. */
    onCancel?: () => void;
  }

  let { editing = false, editText = '', onEditChange, onConfirm, onCancel }: Props = $props();

  let editTextareaEl = $state<HTMLTextAreaElement>();

  // Svelte 5: effect runs after DOM render whenever `editing` becomes true and the element is mounted.
  $effect(() => {
    if (editing && editTextareaEl) {
      editTextareaEl.focus();
      // Move the cursor to the end of the existing text.
      const length = editTextareaEl.value.length;
      editTextareaEl.selectionStart = length;
      editTextareaEl.selectionEnd = length;
    }
  });
</script>

{#if editing}
  <div class="animate-in fade-in mt-1 flex min-w-[220px] flex-col gap-2 duration-200">
    <textarea
      bind:this={editTextareaEl}
      value={editText}
      oninput={(e) => onEditChange?.(e.currentTarget.value)}
      rows="3"
      class="text-cn-ink focus:ring-cn-ink/30 placeholder:text-cn-ink/50 w-full max-w-full resize-none rounded-xl border border-black/10 bg-white/40 px-3 py-2.5 text-sm [overflow-wrap:anywhere] break-words whitespace-pre-wrap shadow-inner backdrop-blur-sm transition-all focus:ring-2 focus:outline-none"
      placeholder={m.msg_edit_placeholder()}
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel?.();
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onConfirm?.();
        }
      }}></textarea>

    <div class="flex items-center justify-between">
      <!-- Keyboard shortcut hint (hidden on mobile) -->
      <span class="text-cn-ink hidden text-[0.65rem] font-medium opacity-60 sm:block">
        {m.msg_edit_keyboard_hint()}
      </span>
      <span class="sm:hidden"></span>

      <div class="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onclick={onCancel}
          class="text-cn-ink rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-black/10"
        >
          {m.common_cancel_button()}
        </button>
        <button
          type="button"
          onclick={onConfirm}
          class="bg-cn-ink rounded-lg px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-black hover:shadow-md"
        >
          {m.common_save_button()}
        </button>
      </div>
    </div>
  </div>
{/if}
