<script lang="ts">
  /**
   * ONE PERSON IN A FOLLOW LIST (WP-F4): the request inbox, the followers list and the sent requests all
   * draw the same row - the avatar and the name, both linking to the profile, the time the row means
   * (asked, or accepted), and the list's own actions on the right.
   *
   * The lists carry ids only, so the name is resolved here through the shared directory cache; a
   * name that cannot be resolved shows the generic "someone" label, never the raw id.
   */
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { peekUserDisplayName, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { formatRelative } from '$lib/utils/time';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    userId: string;
    /** When the row's fact began: the ask, or the acceptance. */
    createdAt: string;
    /** The list's buttons. */
    actions: Snippet;
  }

  let { userId, createdAt, actions }: Props = $props();

  let name = $state<string | null>(null);

  $effect(() => {
    const id = userId;
    name = peekUserDisplayName(id);
    if (name) return;
    let cancelled = false;
    resolveUserDisplayName(id)
      .then((resolved) => {
        if (!cancelled) name = resolved;
      })
      .catch((e: unknown) => Log.d('FollowPersonRow', `name of ${id.slice(0, 8)}: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  });
</script>

<li class="border-cn-border bg-cn-surface flex items-center gap-3 rounded-xl border px-3 py-2.5">
  <a
    href={resolve(`/profile/${encodeURIComponent(userId)}`)}
    class="flex min-w-0 flex-1 items-center gap-3"
    data-follow-person={userId}
  >
    <span class="h-10 w-10 shrink-0 overflow-hidden rounded-full">
      <Avatar {userId} fill shape="circle" fallbackLabel={name ?? ''} />
    </span>
    <span class="min-w-0 flex-1">
      <span class="text-text-main block truncate text-sm font-semibold">
        {name ?? m.notif_actor_unknown()}
      </span>
      <span class="text-text-muted block text-xs">{formatRelative(createdAt)}</span>
    </span>
  </a>
  <div class="flex shrink-0 items-center gap-2">
    {@render actions()}
  </div>
</li>
