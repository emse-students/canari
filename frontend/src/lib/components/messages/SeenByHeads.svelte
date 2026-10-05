<script lang="ts">
  import { CheckCheck } from '@lucide/svelte';
  import Avatar from '../shared/Avatar.svelte';
  import { m } from '$lib/paraglide/messages';
  import { userDisplayNames } from '$lib/utils/users/displayNames.svelte';

  /**
   * The heads of who has read a message: three avatars at most, then `+N`. ONE drawing for both
   * placements - under a DM sender's last read message (`MessageMetadata`, with the double check),
   * and under the last message each member read in a group or a salon (`ChatMessageGroups`).
   */
  interface Props {
    /** Normalised user ids, already sorted by the caller. */
    readers: string[];
    /** Draws the double check after the heads - the DM receipt's shape. */
    withCheck?: boolean;
  }

  let { readers, withCheck = false }: Props = $props();

  const MAX_HEADS = 3;

  /**
   * Every reader's name, kept live. Each head already carries its own name as a tooltip (`Avatar`);
   * these serve who the heads cannot: the readers folded into `+N`, and assistive technology, from
   * which the heads are hidden.
   */
  const names = userDisplayNames(() => readers);
  const nameOf = (userId: string) => names.get(userId) ?? userId;
  let foldedNames = $derived(readers.slice(MAX_HEADS).map(nameOf).join(', '));
  let allNames = $derived(readers.map(nameOf).join(', '));
</script>

<span class="msg-status msg-status-read inline-flex items-center gap-0.5" role="status">
  <span class="inline-flex items-center gap-0.5" aria-hidden="true">
    {#each readers.slice(0, MAX_HEADS) as userId (userId)}
      <Avatar {userId} size="xs" shape="circle" />
    {/each}
    {#if readers.length > MAX_HEADS}
      <span class="text-2xs font-bold opacity-70" title={foldedNames}
        >+{readers.length - MAX_HEADS}</span
      >
    {/if}
    {#if withCheck}
      <CheckCheck
        size={12}
        strokeWidth={2.5}
        class="ml-0.5 text-emerald-500 dark:text-emerald-400"
      />
    {/if}
  </span>
  <span class="sr-only">{m.msg_statut_lu_par_noms({ names: allNames })}</span>
</span>
