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

<header
  class="border-cn-border sticky top-0 z-20 hidden flex-shrink-0 border-b bg-(--surface-elevated) backdrop-blur-sm md:block"
>
  <div class="flex h-14 items-center justify-between gap-3 px-4 md:px-6">
    <!-- Left: Brand -->
    <div class="flex flex-shrink-0 items-center gap-2">
      <CanariBrand compact={true} />
    </div>

    <!-- Right: Status + Theme + actions -->
    <div class="ml-auto flex flex-shrink-0 items-center gap-2">
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
