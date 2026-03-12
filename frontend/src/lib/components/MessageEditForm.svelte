<script lang="ts">
  interface Props {
    editing: boolean;
    editText: string;
    onEditChange?: (text: string) => void;
    onConfirm?: () => void;
    onCancel?: () => void;
  }

  let { editing = false, editText = '', onEditChange, onConfirm, onCancel }: Props = $props();

  let editTextareaEl = $state<HTMLTextAreaElement>();

  function _focusTextarea() {
    if (editTextareaEl) {
      editTextareaEl.focus();
      editTextareaEl.selectionStart = editTextareaEl.value.length;
      editTextareaEl.selectionEnd = editTextareaEl.value.length;
    }
  }
</script>

{#if editing}
  <div class="flex flex-col gap-2 min-w-[220px]">
    <textarea
      bind:this={editTextareaEl}
      value={editText}
      onchange={(e) => onEditChange?.((e.target as HTMLTextAreaElement).value)}
      oninput={(e) => onEditChange?.((e.target as HTMLTextAreaElement).value)}
      rows="3"
      class="w-full px-3 py-2 rounded-lg border border-black/15 bg-white/80 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-cn-yellow/50"
      placeholder="Modifier le message..."
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel?.();
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onConfirm?.();
        }
      }}
    ></textarea>
    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        onclick={onCancel}
        class="px-3 py-1.5 rounded-lg text-xs bg-black/5 hover:bg-black/10 transition-colors"
      >
        Annuler
      </button>
      <button
        type="button"
        onclick={onConfirm}
        class="px-3 py-1.5 rounded-lg text-xs bg-cn-dark text-cn-yellow hover:opacity-90 transition-opacity"
      >
        Enregistrer
      </button>
    </div>
  </div>
{/if}

{#if editing}
  <script>
    // Small script to ensure focus happens after the component renders
    import { tick } from 'svelte';
    tick().then(() => focusTextarea());
  </script>
{/if}
