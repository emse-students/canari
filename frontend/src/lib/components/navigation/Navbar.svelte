<script lang="ts">
  import StatusPill from '../shared/StatusPill.svelte';
  import CanariBrand from './CanariBrand.svelte';
  import SessionActionButtons from './SessionActionButtons.svelte';
  import Avatar from '../shared/Avatar.svelte';
  import { goto } from '$app/navigation';
  import { clearAuth } from '$lib/stores/auth';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { m } from '$lib/paraglide/messages';

  async function handleLogout() {
    await clearAuth();
    void goto('/login', { replaceState: true });
  }
</script>

<!--
  THE HEIGHT IS ON THE ELEMENT THAT CARRIES THE BORDER, and that is the whole of this comment.

  It used to sit on the inner row, so the bar RENDERED 73px - 72 of row plus its own 1px hairline -
  while `--app-content-top` summed to 72. Every card that hangs below the bar was therefore one
  pixel too high and one pixel too tall, and the token whose entire claim is "this is where the
  content starts" was wrong for all of them at once. Measured on the live estate 2026-09-22: the
  scrollport began at y=73 against a token saying 72.

  `box-sizing: border-box` is Tailwind's default, so naming the height here makes the bar exactly
  `--app-top-bar-height` INCLUDING the hairline, and the token true by construction rather than by
  a 1px correction nobody could later explain. The row takes `h-full`.
-->
<header
  data-swipe-nav-ignore
  class="app-top-bar border-cn-border sticky top-0 z-20 hidden h-(--app-top-bar-height) shrink-0 border-b bg-(--surface-elevated) md:block"
>
  <div class="flex h-full items-center justify-between gap-3 px-4 py-2 md:px-6">
    <!-- Left: Brand -->
    <div class="flex shrink-0 items-center gap-2">
      <CanariBrand compact={true} />
    </div>

    <!-- Right: Status + Theme + actions -->
    <div class="ml-auto flex shrink-0 items-center gap-2">
      <StatusPill isConnected={globalSession.isWsConnected} />
      <SessionActionButtons onLogout={handleLogout} />
      {#if globalSession.isLoggedIn && globalSession.userId}
        <button
          type="button"
          onclick={() => goto('/profile')}
          title={m.nav_my_profile_title()}
          class="rounded-2xl ring-2 ring-transparent transition-all duration-200 hover:ring-amber-400"
          aria-label={m.nav_my_profile_label()}
        >
          <Avatar userId={globalSession.userId} size="sm" />
        </button>
      {/if}
    </div>
  </div>
</header>
