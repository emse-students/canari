<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Plus, Search } from '@lucide/svelte';
  import CanariBrand from './CanariBrand.svelte';
  import PostNotificationBell from './PostNotificationBell.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * Whether the three feed controls belong on this route.
   *
   * ALL THREE ARE ABOUT POSTS AND NOTHING ELSE: `+` publishes a post, the magnifier searches the
   * feed, and the bell counts POST notifications (`getPostNotifications`; chat carries its own
   * unread marks on the Discussions tab). Drawn on every route they promised things the route could
   * not do - a `+` on Discussions publishes nothing there - so they are drawn where they mean
   * something (user, 2026-09-14: *"ca n'a pas de sens sur les autres onglets non ?"*).
   *
   * The whole `/posts` area, not just the feed index, because a post's own page is still the posts
   * area and both links navigate back to the feed on their own.
   *
   * THIS IS NOT #636 COMING BACK. That defect was `/notifications` reachable by NO link at all on a
   * phone - the sidebar is `display: none` at this width and `notifications` is `mobileNav: false`.
   * It is now reachable from the tab it belongs to, which is where a post-notifications page goes.
   */
  const onPosts = $derived(page.url.pathname.startsWith('/posts'));
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
  THERE. Here they cost no page height at all - which is the whole of what the feed reclaimed - and
  they are drawn on the `/posts` area only, because that is the only place any of them means
  anything (see `onPosts`). What is left on every other tab is the brand and the avatar.

  THE BOX IS `.ui-icon-button`'S, NOT THIS FILE'S. The three controls used to type `h-11 w-11` each,
  which is the shared 44px touch box spelt out three times - and `iconButtonScale.test.ts` fails a
  button that declares a box under its own name, because a fourth size is how the last four got in.
  This header is `md:hidden`, so the class is only ever its 44px touch form here; the round corner,
  the ring and the hover tint stay local because those are this header's, not the scale's.

  BOTH ARE LINKS, NOT STORE WRITES. `/posts?compose=1` and `/posts?search=1` are commands the feed
  page obeys and then strips from the URL. A link needs no shared state between a header component
  and a page, and it is right-clickable, middle-clickable and reloadable because it is a real
  destination. The magnifier says "search the feed" rather than "search everything", which is what it
  does: this app has no global search, and a glyph that jumped somewhere unrelated would be a promise
  nothing keeps.
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
      {#if onPosts}
        <a
          href="/posts?compose=1"
          title={m.posts_publish_button()}
          aria-label={m.posts_publish_button()}
          class="ui-icon-button text-text-muted hover:text-text hover:bg-cn-surface rounded-full"
        >
          <Plus size={24} strokeWidth={2.5} />
        </a>
        <a
          href="/posts?search=1"
          title={m.posts_search_placeholder()}
          aria-label={m.posts_search_placeholder()}
          class="ui-icon-button text-text-muted hover:text-text hover:bg-cn-surface rounded-full"
        >
          <Search size={24} strokeWidth={2.5} />
        </a>
        <PostNotificationBell />
      {/if}
      {#if globalSession.userId}
        <button
          type="button"
          onclick={() => goto('/profile')}
          title={m.nav_my_profile_title()}
          aria-label={m.nav_my_profile_label()}
          class="ui-icon-button rounded-2xl ring-2 ring-transparent transition-all duration-200 hover:ring-amber-400"
        >
          <Avatar userId={globalSession.userId} size="md" />
        </button>
      {/if}
    {/if}
  </div>
</header>
