<script lang="ts">
  import { Reply, Smile, Pencil, Trash2 } from '@lucide/svelte';
  import { fly, fade } from 'svelte/transition';

  interface Props {
    /** Whether the radial action menu overlay is visible. */
    visible: boolean;
    /** When true, the message belongs to the current user (gates edit/delete). */
    isOwn?: boolean;
    /** When true, hides reply and edit actions (message has been deleted). */
    isDeleted?: boolean;
    /** When true, hides the edit action (media messages cannot be edited). */
    hasMedia?: boolean;
    /** When false, hides the reply button. */
    canReply?: boolean;
    /** When false, hides the react button. */
    canReact?: boolean;
    /** When false, hides the edit button. */
    canEdit?: boolean;
    /** When false, hides the delete button. */
    canDelete?: boolean;
    /** Called when the user taps the reply button. */
    onReply?: () => void;
    /** Called when the user taps the react (emoji) button. */
    onReact?: () => void;
    /** Called when the user taps the edit button. */
    onEdit?: () => void;
    /** Called when the user taps the delete button. */
    onDelete?: () => void;
    /** Called when the backdrop or center button is tapped to close the menu. */
    onClose?: () => void;
  }

  let {
    visible = false,
    isOwn = false,
    isDeleted = false,
    hasMedia = false,
    canReply = true,
    canReact = true,
    canEdit = true,
    canDelete = true,
    onReply,
    onReact,
    onEdit,
    onDelete,
    onClose,
  }: Props = $props();
</script>

{#if visible}
  <div class="fixed inset-0 z-[110] md:hidden">
    <button
      type="button"
      class="absolute inset-0 bg-black/45 backdrop-blur-sm cursor-default outline-none"
      aria-label="Fermer le menu des actions"
      onclick={onClose}
      transition:fade={{ duration: 180 }}
    ></button>

    <div
      class="absolute inset-x-0 bottom-[max(4.5rem,env(safe-area-inset-bottom)+3rem)] flex items-center justify-center"
      transition:fly={{ y: 24, duration: 220 }}
    >
      <div class="relative w-56 h-56">
        <button
          type="button"
          class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full bg-white/90 dark:bg-[var(--cn-surface)]/95 border border-black/10 dark:border-white/10 shadow-xl inline-flex items-center justify-center text-text-main"
          onclick={onClose}
          aria-label="Fermer"
        >
          •••
        </button>

        {#if !isDeleted && canReply}
          <button
            onclick={() => {
              onReply?.();
              onClose?.();
            }}
            class="absolute left-1/2 top-1 -translate-x-1/2 w-14 h-14 rounded-full bg-white/90 dark:bg-[var(--cn-surface)]/95 border border-black/10 dark:border-white/10 shadow-lg inline-flex items-center justify-center text-text-main active:scale-95"
            aria-label="Répondre"
            title="Répondre"
          >
            <Reply size={20} />
          </button>
        {/if}

        {#if canReact}
          <button
            onclick={() => {
              onReact?.();
              onClose?.();
            }}
            class="absolute right-2 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-white/90 dark:bg-[var(--cn-surface)]/95 border border-black/10 dark:border-white/10 shadow-lg inline-flex items-center justify-center text-amber-500 active:scale-95"
            aria-label="Réagir"
            title="Réagir"
          >
            <Smile size={20} />
          </button>
        {/if}

        {#if !isDeleted && isOwn && !hasMedia && canEdit}
          <button
            onclick={() => {
              onEdit?.();
              onClose?.();
            }}
            class="absolute left-2 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-white/90 dark:bg-[var(--cn-surface)]/95 border border-black/10 dark:border-white/10 shadow-lg inline-flex items-center justify-center text-blue-500 active:scale-95"
            aria-label="Modifier"
            title="Modifier"
          >
            <Pencil size={20} />
          </button>
        {/if}

        {#if !isDeleted && isOwn && canDelete}
          <button
            onclick={() => {
              onDelete?.();
              onClose?.();
            }}
            class="absolute left-1/2 bottom-1 -translate-x-1/2 w-14 h-14 rounded-full bg-red-500/90 border border-red-400/30 shadow-lg inline-flex items-center justify-center text-white active:scale-95"
            aria-label="Supprimer"
            title="Supprimer"
          >
            <Trash2 size={20} />
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
