<script lang="ts">
  import { format } from 'date-fns';
  import { fly } from 'svelte/transition';

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
    class="absolute {isOwn
      ? 'right-0'
      : 'left-0'} top-full mt-1 px-3 py-1.5 bg-gray-800 text-white text-[0.65rem] rounded-lg shadow-lg z-50 whitespace-nowrap flex flex-col gap-0.5 pointer-events-none"
    in:fly={{ y: -3, duration: 100 }}
  >
    <span>
      Envoyé à {format(timestamp, 'HH:mm')}{#if isEdited && editedAt}, Modifié à {format(
          editedAt,
          'HH:mm'
        )}{:else if isEdited}, Modifié{/if}
    </span>
    {#if readBy.length > 0}
      <span class="text-blue-300">Lu par {readBy.join(', ')}</span>
    {/if}
  </div>
{/if}
