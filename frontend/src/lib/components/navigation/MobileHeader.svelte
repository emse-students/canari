<script lang="ts">
  import { goto } from '$app/navigation';
  import { Plus, Search } from '@lucide/svelte';
  import CanariBrand from './CanariBrand.svelte';
  import PostNotificationBell from './PostNotificationBell.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { m } from '$lib/paraglide/messages';
</script>

<!--
  THE PHONE'S APP HEADER (md:hidden): brand on the left, every control on the right.

  IT USED TO CENTRE THE BRAND WITH AN EMPTY BOX. A `w-[4.5rem]` spacer mirrored the actions group so
  the logo would sit in the middle, which means the header could hold exactly as many controls as
  that number had been guessed for - a third one would have pushed the brand off centre and needed
  the spacer retyped. Read on this phone on 2026-09-14, Facebook's own header is the other shape:
  wordmark hard left, actions hard right, and it takes three controls without arithmetic.

  THE `+` AND THE MAGNIFIER ARE WHY IT CHANGED. Publishing and searching were reachable only from
  the feed's own page heading, as a labelled button and a permanent 66 px field that cost two rows
  THERE and existed nowhere else. Here they are one tap from every page and cost no page height at
  all - which is the whole of what the feed reclaimed.

  BOTH ARE LINKS, NOT STORE WRITES. `/posts?compose=1` and `/posts?search=1` are commands the feed
  page obeys and then strips from the URL. A link needs no shared state between a header that exists
  on every route and a page that exists on one, it works from any route, and it is right-clickable,
  middle-clickable and reloadable because it is a real destination. The magnifier says "search the
  feed" rather than "search everything", which is what it does: this app has no global search, and a
  glyph that jumped somewhere unrelated from `/directory` would be a promise nothing keeps.
-->
<header
  class="border-cn-border z-20 flex h-14 shrink-0 items-center justify-between
 border-b bg-(--surface-elevated) px-3 md:hidden"
>
  <a href="/posts" aria-label={m.nav_home_label()} class="flex min-w-0 items-center">
    <CanariBrand subtitle="" />
  </a>

  <div class="flex shrink-0 items-center gap-1">
    {#if globalSession.isLoggedIn}
      <a
        href="/posts?compose=1"
        title={m.posts_publish_button()}
        aria-label={m.posts_publish_button()}
        class="text-text-muted hover:text-text hover:bg-cn-surface flex h-9 w-9 items-center justify-center rounded-full transition-colors"
      >
        <Plus size={20} strokeWidth={2.5} />
      </a>
      <a
        href="/posts?search=1"
        title={m.posts_search_placeholder()}
        aria-label={m.posts_search_placeholder()}
        class="text-text-muted hover:text-text hover:bg-cn-surface flex h-9 w-9 items-center justify-center rounded-full transition-colors"
      >
        <Search size={20} strokeWidth={2.5} />
      </a>
      <PostNotificationBell />
      {#if globalSession.userId}
        <button
          type="button"
          onclick={() => goto('/profile')}
          title={m.nav_my_profile_title()}
          aria-label={m.nav_my_profile_label()}
          class="ml-0.5 rounded-2xl ring-2 ring-transparent transition-all duration-200 hover:ring-amber-400"
        >
          <Avatar userId={globalSession.userId} size="sm" />
        </button>
      {/if}
    {/if}
  </div>
</header>
