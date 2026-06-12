<script lang="ts">
  import { Reply, Forward, Pencil, Trash2, SmilePlus } from '@lucide/svelte';
  import { fly, fade } from 'svelte/transition';

  /** Quick-reaction emojis shown in the strip (WhatsApp/Messenger style). */
  const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '😡'] as const;

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
    /** Emojis the current user has already reacted with (highlights them in the strip). */
    userReactions?: string[];
    /** Called when the user taps a quick emoji in the reaction strip. */
    onReactEmoji?: (emoji: string) => void;
    /** Called when the user taps the "+" button to open the full emoji picker. */
    onOpenFullPicker?: () => void;
    /** Called when the user taps the reply button. */
    onReply?: () => void;
    /** Called when the user taps the forward button. */
    onForward?: () => void;
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
    userReactions = [],
    onReactEmoji,
    onOpenFullPicker,
    onReply,
    onForward,
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
      data-keyboard-aware-actions
      class="absolute inset-x-0 flex flex-col items-center gap-4"
      transition:fly={{ y: 24, duration: 220 }}
    >
      {#if !isDeleted && canReact}
        <!-- Quick emoji reaction strip (WhatsApp/Messenger style) -->
        <div
          class="flex items-center gap-1 px-3 py-2 bg-white/95 dark:bg-[var(--cn-surface)] rounded-full border border-black/10 dark:border-white/10 shadow-2xl"
        >
          {#each QUICK_EMOJIS as emoji (emoji)}
            {@const isActive = userReactions.includes(emoji)}
            <button
              type="button"
              class="w-11 h-11 rounded-full text-2xl leading-none flex items-center justify-center transition-transform active:scale-75 {isActive
                ? 'bg-amber-400/20 ring-2 ring-amber-400'
                : 'hover:bg-black/5 dark:hover:bg-white/10'}"
              aria-label="Réagir avec {emoji}"
              aria-pressed={isActive}
              onclick={() => {
                onReactEmoji?.(emoji);
                onClose?.();
              }}
            >
              {emoji}
            </button>
          {/each}
          <button
            type="button"
            class="w-11 h-11 rounded-full flex items-center justify-center text-text-muted hover:bg-black/5 dark:hover:bg-white/10 transition-transform active:scale-75"
            aria-label="Plus de réactions"
            onclick={() => {
              onOpenFullPicker?.();
              onClose?.();
            }}
          >
            <SmilePlus size={22} />
          </button>
        </div>
      {/if}

      <!-- Action buttons row -->
      <div
        class="flex items-center gap-3 px-4 py-3 bg-white/90 dark:bg-[var(--cn-surface)]/95 rounded-2xl border border-black/10 dark:border-white/10 shadow-xl"
      >
        {#if !isDeleted && canReply}
          <button
            onclick={() => {
              onReply?.();
              onClose?.();
            }}
            class="flex flex-col items-center gap-1 px-3 py-2 rounded-xl text-text-main active:scale-95 transition-transform hover:bg-black/5 dark:hover:bg-white/5"
            aria-label="Répondre"
          >
            <Reply size={20} />
            <span class="text-[10px] font-medium text-text-muted">Répondre</span>
          </button>
        {/if}

        {#if !isDeleted && onForward}
          <button
            onclick={() => {
              onForward?.();
              onClose?.();
            }}
            class="flex flex-col items-center gap-1 px-3 py-2 rounded-xl text-text-main active:scale-95 transition-transform hover:bg-black/5 dark:hover:bg-white/5"
            aria-label="Transférer"
          >
            <Forward size={20} />
            <span class="text-[10px] font-medium text-text-muted">Transférer</span>
          </button>
        {/if}

        {#if !isDeleted && isOwn && !hasMedia && canEdit}
          <button
            onclick={() => {
              onEdit?.();
              onClose?.();
            }}
            class="flex flex-col items-center gap-1 px-3 py-2 rounded-xl text-blue-500 active:scale-95 transition-transform hover:bg-blue-500/10"
            aria-label="Modifier"
          >
            <Pencil size={20} />
            <span class="text-[10px] font-medium">Modifier</span>
          </button>
        {/if}

        {#if !isDeleted && isOwn && canDelete}
          <button
            onclick={() => {
              onDelete?.();
              onClose?.();
            }}
            class="flex flex-col items-center gap-1 px-3 py-2 rounded-xl text-red-500 active:scale-95 transition-transform hover:bg-red-500/10"
            aria-label="Supprimer"
          >
            <Trash2 size={20} />
            <span class="text-[10px] font-medium">Supprimer</span>
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
