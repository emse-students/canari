<script lang="ts">
  /**
   * ONE PERSON IN THE DIRECTORY: avatar, name, a line of promo / status / campus, the bio, and the
   * quiet "Suivre" control.
   *
   * The row is a STRETCHED link (the name's anchor paints an `after` layer over the row) so "Suivre"
   * can sit on the meta line as a sibling of that anchor, above its layer (`relative z-10`): a button
   * inside a link is invalid (owner, 2026-11-10).
   */
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import FollowChip from '$lib/components/follows/FollowChip.svelte';
  import type { DirectoryUserRow } from '$lib/profile/api';
  import { campusLabel, postLabel } from '$lib/profile/miconnectProfile';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    user: DirectoryUserRow;
  }
  let { user }: Props = $props();

  const name = $derived(
    user.displayName?.trim() || getUserDisplayNameSync(user.id, user.id.slice(0, 8) + '…')
  );
  /** The meta line's pieces, joined by a dot in the markup: cursus entries, posts, campus. */
  const facts = $derived([
    ...user.cursus.map((c) => `${c.formation} ${m.directory_user_promo({ year: c.promo })}`),
    ...user.posts.map((p) => postLabel(p)),
    ...(user.campus ? [campusLabel(user.campus)] : []),
  ]);
</script>

<li
  class="hover:bg-cn-surface-alt relative flex min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors"
  data-directory-row
>
  <div class="h-12 w-12 shrink-0 overflow-hidden rounded-full">
    <Avatar userId={user.id} fill shape="circle" />
  </div>
  <div class="min-w-0 flex-1">
    <p class="text-text-main truncate text-sm font-semibold">
      <a
        href="/profile/{encodeURIComponent(user.id)}"
        class="after:absolute after:inset-0 after:content-['']">{name}</a
      >
    </p>
    <p class="text-text-muted flex flex-wrap items-center gap-x-1.5 text-xs">
      {#each facts as fact, i (i)}
        {#if i > 0}<span aria-hidden="true">·</span>{/if}
        <span>{fact}</span>
      {/each}
      <span class="relative z-10 flex items-center gap-x-1.5 empty:hidden">
        <FollowChip kind="user" targetId={user.id} {name} dotted={facts.length > 0} />
      </span>
    </p>
    {#if user.bio?.trim()}
      <p class="text-text-muted mt-0.5 line-clamp-1 text-xs">{user.bio}</p>
    {/if}
  </div>
</li>
