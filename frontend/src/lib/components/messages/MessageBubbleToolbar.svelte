<script lang="ts">
  import { Reply, Forward, Smile, Pencil, Trash2 } from '@lucide/svelte';

  /** Quick-reaction emojis shown inline in the web hover toolbar (mirrors mobile). */
  const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '😡'] as const;

  interface Props {
    /** When true, positions the toolbar on the right side. */
    isOwn: boolean;
    /** When true, hides reply and edit/delete actions. */
    isDeleted: boolean;
    /** When true, hides the edit action (media messages cannot be edited). */
    hasMedia: boolean;
    /** When true, keeps the toolbar fully visible (emoji picker is open). */
    showEmojiPicker: boolean;
    /** When true, forces the toolbar visible on mobile (triggered by long press). */
    forceVisible?: boolean;
    /** Called when the reply button is clicked. Omit to hide the button. */
    onReply?: () => void;
    /** Called when the forward button is clicked. Omit to hide the button. */
    onForward?: () => void;
    /** Called when a quick-reaction emoji is clicked. Omit to hide the strip. */
    onReact?: (emoji: string) => void;
    /** Emojis the current user already reacted with (highlights them in the strip). */
    userReactions?: string[];
    /** Called when the "more reactions" (+) button is clicked. Omit to hide the button. */
    onToggleEmojiPicker?: () => void;
    /** Called when the edit button is clicked. Omit to hide the button. */
    onEdit?: () => void;
    /** Called when the delete button is clicked. Omit to hide the button. */
    onDelete?: () => void;
  }

  let {
    isOwn,
    isDeleted,
    hasMedia,
    showEmojiPicker,
    forceVisible = false,
    onReply,
    onForward,
    onReact,
    userReactions = [],
    onToggleEmojiPicker,
    onEdit,
    onDelete,
  }: Props = $props();
</script>

<div
  class="absolute {forceVisible
    ? 'bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap'
    : isOwn
      ? 'top-1/2 -translate-y-1/2 right-full mr-2'
      : 'top-1/2 -translate-y-1/2 left-full ml-2'} opacity-0 {showEmojiPicker || forceVisible
    ? 'opacity-100'
    : 'group-hover:opacity-100'} transition-opacity duration-200 {forceVisible
    ? 'flex'
    : 'hidden md:flex'} flex-row items-center gap-0.5 rounded-full bg-white/90 dark:bg-black/70 backdrop-blur-xl border border-black/5 dark:border-white/10 shadow-lg px-2 py-1.5 z-10 text-text-muted"
>
  <!-- Réactions rapides (web) : même set que mobile, masquées en mode long-press mobile
       où MessageMobileActions affiche déjà sa propre bande de réactions. -->
  {#if !isDeleted && onReact && !forceVisible}
    {#each QUICK_EMOJIS as emoji (emoji)}
      {@const isActive = userReactions.includes(emoji)}
      <button
        onclick={(e) => {
          e.stopPropagation();
          onReact?.(emoji);
        }}
        class="w-7 h-7 rounded-full text-base leading-none flex items-center justify-center transition-transform hover:scale-125 active:scale-95 {isActive
          ? 'bg-amber-400/20 ring-1 ring-amber-400'
          : 'hover:bg-black/5 dark:hover:bg-white/10'}"
        aria-label="Réagir avec {emoji}"
        aria-pressed={isActive}
        title="Réagir avec {emoji}"
      >
        {emoji}
      </button>
    {/each}
    <div class="mx-0.5 self-stretch w-px bg-black/10 dark:bg-white/10"></div>
  {/if}
  {#if !isDeleted && onReply}
    <button
      onclick={() => onReply?.()}
      class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-colors"
      aria-label="Répondre"
      title="Répondre"
    >
      <Reply size={16} />
    </button>
  {/if}
  {#if !isDeleted && onForward}
    <button
      onclick={(e) => {
        e.stopPropagation();
        onForward?.();
      }}
      class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-colors"
      aria-label="Transférer"
      title="Transférer"
    >
      <Forward size={16} />
    </button>
  {/if}
  {#if onToggleEmojiPicker}
    <button
      onclick={(e) => {
        e.stopPropagation();
        onToggleEmojiPicker?.();
      }}
      class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-amber-500 transition-colors"
      aria-label={onReact ? 'Plus de réactions' : 'Réagir'}
      title={onReact ? 'Plus de réactions' : 'Réagir'}
    >
      <Smile size={16} />
    </button>
  {/if}
  {#if !isDeleted && isOwn && !hasMedia && onEdit}
    <button
      onclick={(e) => {
        e.stopPropagation();
        onEdit?.();
      }}
      class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-blue-500 transition-colors"
      aria-label="Modifier"
      title="Modifier"
    >
      <Pencil size={16} />
    </button>
  {/if}
  {#if !isDeleted && isOwn && onDelete}
    <button
      onclick={(e) => {
        e.stopPropagation();
        onDelete?.();
      }}
      class="p-1.5 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors"
      aria-label="Supprimer"
      title="Supprimer"
    >
      <Trash2 size={16} />
    </button>
  {/if}
</div>
