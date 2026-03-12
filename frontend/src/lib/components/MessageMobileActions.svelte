<script lang="ts">
  import { Reply, Smile, Pencil, Trash2 } from 'lucide-svelte';
  import { fly } from 'svelte/transition';

  interface Props {
    visible: boolean;
    isOwn?: boolean;
    isDeleted?: boolean;
    hasMedia?: boolean;
    canReply?: boolean;
    canReact?: boolean;
    canEdit?: boolean;
    canDelete?: boolean;
    onReply?: () => void;
    onReact?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
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
  <button
    type="button"
    class="fixed inset-0 z-40 bg-black/30 md:hidden"
    aria-label="Fermer le menu des actions"
    onclick={onClose}
  ></button>
  <div
    class="fixed inset-x-0 bottom-0 z-50 md:hidden rounded-t-3xl bg-[var(--cn-surface)] border-t border-cn-border shadow-2xl p-4"
    in:fly={{ y: 12, duration: 120 }}
  >
    <div class="w-12 h-1.5 rounded-full bg-gray-200 mx-auto mb-4"></div>
    <div class="grid grid-cols-2 gap-2">
      {#if !isDeleted && canReply}
        <button
          onclick={() => {
            onReply?.();
            onClose?.();
          }}
          class="px-3 py-2.5 rounded-xl bg-cn-bg text-sm font-medium flex items-center justify-center gap-2"
        >
          <Reply size={15} /> Repondre
        </button>
      {/if}
      {#if canReact}
        <button
          onclick={() => {
            onReact?.();
            onClose?.();
          }}
          class="px-3 py-2.5 rounded-xl bg-cn-bg text-sm font-medium flex items-center justify-center gap-2"
        >
          <Smile size={15} /> Reagir
        </button>
      {/if}
      {#if !isDeleted && isOwn && !hasMedia && canEdit}
        <button
          onclick={() => {
            onEdit?.();
            onClose?.();
          }}
          class="px-3 py-2.5 rounded-xl bg-cn-bg text-sm font-medium flex items-center justify-center gap-2"
        >
          <Pencil size={15} /> Modifier
        </button>
      {/if}
      {#if !isDeleted && isOwn && canDelete}
        <button
          onclick={() => {
            onDelete?.();
            onClose?.();
          }}
          class="px-3 py-2.5 rounded-xl bg-red-50 text-red-600 text-sm font-medium flex items-center justify-center gap-2"
        >
          <Trash2 size={15} /> Supprimer
        </button>
      {/if}
    </div>
  </div>
{/if}
