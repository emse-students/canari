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
  <div class="flex flex-col gap-2 min-w-[220px] mt-1 animate-in fade-in duration-200">
    <textarea
      bind:this={editTextareaEl}
      value={editText}
      oninput={(e) => onEditChange?.(e.currentTarget.value)}
      rows="3"
      class="w-full max-w-full px-3 py-2.5 rounded-xl border border-black/10 bg-white/40 shadow-inner text-sm text-cn-ink resize-none whitespace-pre-wrap break-words [overflow-wrap:anywhere] focus:outline-none focus:ring-2 focus:ring-cn-ink/30 placeholder:text-cn-ink/50 transition-all backdrop-blur-sm"
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
      <span class="text-[0.65rem] font-medium opacity-60 text-cn-ink hidden sm:block">
        {m.msg_edit_keyboard_hint()}
      </span>
      <span class="sm:hidden"></span>

      <div class="flex items-center gap-1.5 ml-auto">
        <button
          type="button"
          onclick={onCancel}
          class="px-3 py-1.5 rounded-lg text-xs font-semibold text-cn-ink hover:bg-black/10 transition-colors"
        >
          {m.common_cancel_button()}
        </button>
        <button
          type="button"
          onclick={onConfirm}
          class="px-3 py-1.5 rounded-lg text-xs font-bold bg-cn-ink text-white hover:bg-black hover:-translate-y-0.5 shadow-sm hover:shadow-md transition-all"
        >
          {m.common_save_button()}
        </button>
      </div>
    </div>
  </div>
{/if}
