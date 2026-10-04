<script lang="ts">
  import { CheckCheck } from '@lucide/svelte';
  import Avatar from '../shared/Avatar.svelte';
  import { m } from '$lib/paraglide/messages';

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
</script>

<span class="msg-status msg-status-read inline-flex items-center gap-0.5" role="status">
  <span class="inline-flex items-center gap-0.5" aria-hidden="true">
    {#each readers.slice(0, MAX_HEADS) as userId (userId)}
      <Avatar {userId} size="xs" shape="circle" />
    {/each}
    {#if readers.length > MAX_HEADS}
      <span class="text-2xs font-bold opacity-70">+{readers.length - MAX_HEADS}</span>
    {/if}
    {#if withCheck}
      <CheckCheck
        size={12}
        strokeWidth={2.5}
        class="ml-0.5 text-emerald-500 dark:text-emerald-400"
      />
    {/if}
  </span>
  <!--
    One key per arity, which is this codebase's convention for counted strings (see
    `chat_typing_one_person` / `_two_people` / `_multiple_people`). The inlang project has no
    ICU plural support, and a single `{count, plural, ...}` message compiles to an input the
    generated type does not carry.
  -->
  <span class="sr-only">
    {readers.length === 1
      ? m.msg_statut_lu_une_personne()
      : m.msg_statut_lu_plusieurs({ count: readers.length })}
  </span>
</span>
