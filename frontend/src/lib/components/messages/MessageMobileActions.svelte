<script lang="ts">
  import { Reply, Smile, Pencil, Trash2 } from 'lucide-svelte';
  import { fly, fade } from 'svelte/transition';

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
  <!-- Conteneur global qui gère le z-index très élevé pour passer au-dessus de tout -->
  <div class="fixed inset-0 z-[110] flex flex-col justify-end md:hidden">

    <!-- Overlay sombre et flouté -->
    <button
      type="button"
      class="absolute inset-0 bg-black/40 backdrop-blur-sm cursor-default outline-none"
      aria-label="Fermer le menu des actions"
      onclick={onClose}
      transition:fade={{ duration: 200 }}
    ></button>

    <!-- Tiroir (Bottom Sheet) -->
    <div
      class="relative w-full rounded-t-[2rem] bg-white/85 dark:bg-[#151B2C]/90 backdrop-blur-2xl border-t border-black/5 dark:border-white/10 shadow-[0_-8px_30px_rgba(0,0,0,0.15)] dark:shadow-[0_-8px_30px_rgba(0,0,0,0.4)] px-5 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] flex flex-col gap-2"
      transition:fly={{ y: '100%', duration: 300, easing: (t) => t * (2 - t) }}
    >
      <!-- Poignée visuelle (Drag handle) -->
      <div class="w-12 h-1.5 rounded-full bg-black/15 dark:bg-white/20 mx-auto mb-4"></div>

      <!-- Liste d'actions -->
      <div class="flex flex-col gap-2.5">
        {#if !isDeleted && canReply}
          <button
            onclick={() => {
              onReply?.();
              onClose?.();
            }}
            class="w-full flex items-center gap-4 px-5 py-4 rounded-2xl bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/5 text-text-main font-semibold text-[0.95rem] active:scale-[0.98] transition-all shadow-sm"
          >
            <div class="flex items-center justify-center text-text-muted">
              <Reply size={20} />
            </div>
            Répondre
          </button>
        {/if}

        {#if canReact}
          <button
            onclick={() => {
              onReact?.();
              onClose?.();
            }}
            class="w-full flex items-center gap-4 px-5 py-4 rounded-2xl bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/5 text-text-main font-semibold text-[0.95rem] active:scale-[0.98] transition-all shadow-sm"
          >
            <div class="flex items-center justify-center text-amber-500">
              <Smile size={20} />
            </div>
            Réagir
          </button>
        {/if}

        {#if !isDeleted && isOwn && !hasMedia && canEdit}
          <button
            onclick={() => {
              onEdit?.();
              onClose?.();
            }}
            class="w-full flex items-center gap-4 px-5 py-4 rounded-2xl bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/5 text-text-main font-semibold text-[0.95rem] active:scale-[0.98] transition-all shadow-sm"
          >
            <div class="flex items-center justify-center text-blue-500">
              <Pencil size={20} />
            </div>
            Modifier
          </button>
        {/if}

        {#if !isDeleted && isOwn && canDelete}
          <!-- Séparateur subtil avant la zone de danger -->
          <div class="h-px w-full bg-black/5 dark:bg-white/10 my-1"></div>

          <button
            onclick={() => {
              onDelete?.();
              onClose?.();
            }}
            class="w-full flex items-center gap-4 px-5 py-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 font-bold text-[0.95rem] active:scale-[0.98] active:bg-red-500/20 transition-all shadow-sm"
          >
            <div class="flex items-center justify-center">
              <Trash2 size={20} />
            </div>
            Supprimer
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
