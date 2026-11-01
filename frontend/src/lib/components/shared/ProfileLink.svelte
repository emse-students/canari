<script lang="ts">
  /**
   * THE AVATAR (OR ANY SMALL BLOCK) THAT OPENS A PERSON'S PROFILE, from a place that already draws
   * them: a message in a conversation, a row of a members list.
   *
   * A real `<a>`, so it is reachable by keyboard and long-pressable like any other link, and it
   * stops the click from reaching the row or bubble that contains it (a row's own tap and a bubble's
   * long-press keep their meaning). NOTHING IS FETCHED to draw it beyond the name the avatar already
   * resolves: the href is built from the id. An account the server has answered does not exist gets
   * no link - the children are drawn bare - and the link is withdrawn if that answer lands after the
   * first paint.
   */
  import type { Snippet } from 'svelte';
  import { profileHref } from '$lib/utils/users/profileHref';
  import { isAbsentUser } from '$lib/utils/users/absentUsers';
  import { userDisplayName } from '$lib/utils/users/displayNames.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The person whose profile opens. */
    userId: string;
    /** What is drawn inside the link, typically an `Avatar`. */
    children: Snippet;
    /** Classes of the link box. */
    class?: string;
  }

  let { userId, children, class: className = '' }: Props = $props();

  const resolved = userDisplayName(() => userId);
  const absent = $derived(isAbsentUser(userId));
</script>

{#if absent || !userId.trim()}
  <span class={className}>{@render children()}</span>
{:else}
  <a
    href={profileHref(userId)}
    class="{className} rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
    aria-label={m.chat_open_profile_label({ name: resolved.current })}
    data-profile-link={userId}
    onclick={(e) => e.stopPropagation()}
  >
    {@render children()}
  </a>
{/if}
