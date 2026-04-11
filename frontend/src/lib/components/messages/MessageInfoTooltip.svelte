<script lang="ts">
  import { format } from 'date-fns';
  import { fly } from 'svelte/transition';
  import { Clock, Pencil, CheckCheck } from 'lucide-svelte';

  interface Props {
    visible: boolean;
    timestamp: Date;
    editedAt?: Date;
    readBy?: string[];
    isOwn?: boolean;
    isEdited?: boolean;
  }

  let {
    visible = false,
    timestamp,
    editedAt,
    readBy = [],
    isOwn = false,
    isEdited = false,
  }: Props = $props();
</script>

{#if visible}
  <div
    class="absolute {isOwn ? 'right-0' : 'left-0'} top-full mt-1.5 px-3.5 py-2.5 bg-white/90 dark:bg-black/80 backdrop-blur-xl border border-black/5 dark:border-white/10 text-text-main text-[0.7rem] rounded-xl shadow-xl shadow-black/10 dark:shadow-black/40 z-50 whitespace-nowrap flex flex-col gap-1.5 pointer-events-none"
    in:fly={{ y: -4, duration: 200, opacity: 0, easing: (t) => t * (2 - t) }}
  >
    <!-- Heure d'envoi -->
    <div class="flex items-center gap-1.5 opacity-90">
      <Clock size={12} class="text-text-muted shrink-0" />
      <span>
        Envoyé à <span class="font-semibold">{format(timestamp, 'HH:mm')}</span>
      </span>
    </div>

    <!-- Heure de modification (si applicable) -->
    {#if isEdited}
      <div class="flex items-center gap-1.5 opacity-90">
        <Pencil size={12} class="text-text-muted shrink-0" />
        <span>
          Modifié {#if editedAt}à <span class="font-semibold">{format(editedAt, 'HH:mm')}</span>{/if}
        </span>
      </div>
    {/if}

    <!-- Liste de lecture -->
    {#if readBy.length > 0}
      <div class="flex items-center gap-1.5 mt-1 pt-1.5 border-t border-black/5 dark:border-white/10">
        <CheckCheck size={14} strokeWidth={2.5} class="text-amber-500 shrink-0" />
        <span class="font-medium text-text-muted">
          Lu par <span class="font-bold text-text-main">{readBy.join(', ')}</span>
        </span>
      </div>
    {/if}
  </div>
{/if}
