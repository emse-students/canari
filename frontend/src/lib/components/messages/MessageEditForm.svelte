<script lang="ts">
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

  // Svelte 5 : L'effet s'exécute automatiquement après le rendu du DOM
  // si 'editing' devient vrai et que l'élément est monté.
  $effect(() => {
    if (editing && editTextareaEl) {
      editTextareaEl.focus();
      // Place le curseur directement à la fin du texte existant
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
      class="w-full px-3 py-2.5 rounded-xl border border-black/10 bg-white/40 shadow-inner text-sm text-cn-dark resize-none focus:outline-none focus:ring-2 focus:ring-cn-dark/30 placeholder:text-cn-dark/50 transition-all backdrop-blur-sm"
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

    <div class="flex items-center justify-between">
      <!-- Indice des raccourcis claviers (caché sur mobile) -->
      <span class="text-[0.65rem] font-medium opacity-60 text-cn-dark hidden sm:block">
        Échap pour annuler • Ctrl+Entrée pour valider
      </span>
      <span class="sm:hidden"></span>

      <div class="flex items-center gap-1.5 ml-auto">
        <button
          type="button"
          onclick={onCancel}
          class="px-3 py-1.5 rounded-lg text-xs font-semibold text-cn-dark hover:bg-black/10 transition-colors"
        >
          Annuler
        </button>
        <button
          type="button"
          onclick={onConfirm}
          class="px-3 py-1.5 rounded-lg text-xs font-bold bg-cn-dark text-white hover:bg-black hover:-translate-y-0.5 shadow-sm hover:shadow-md transition-all"
        >
          Enregistrer
        </button>
      </div>
    </div>
  </div>
{/if}
