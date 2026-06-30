<script lang="ts">
  import StatusPill from '../shared/StatusPill.svelte';
  import CanariBrand from './CanariBrand.svelte';
  import SessionActionButtons from './SessionActionButtons.svelte';
  import Avatar from '../shared/Avatar.svelte';
  import { goto } from '$app/navigation';
  import { clearAuth } from '$lib/stores/auth';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { SlidersHorizontal } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  async function handleLogout() {
    await clearAuth();
    void goto('/login', { replaceState: true });
  }
</script>

<header
  class="hidden md:block sticky top-0 z-20 bg-[var(--surface-elevated)] border-b border-cn-border backdrop-blur-sm flex-shrink-0"
>
  <div class="h-14 flex items-center justify-between px-4 md:px-6 gap-3">
    <!-- Left: Brand -->
    <div class="flex items-center gap-2 flex-shrink-0">
      <CanariBrand compact={true} />
    </div>

    <!-- Right: Status + Theme + actions -->
    <div class="flex items-center gap-2 flex-shrink-0 ml-auto">
      <StatusPill isConnected={globalSession.isWsConnected} />
      {#if globalSession.isLoggedIn}
        <button
          type="button"
          onclick={() => goto('/settings')}
          title={m.nav_settings_title()}
          aria-label={m.nav_settings_label()}
          class="p-2 rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-colors"
        >
          <SlidersHorizontal size={20} />
        </button>
      {/if}
      <SessionActionButtons onLogout={handleLogout} />
      {#if globalSession.isLoggedIn && globalSession.userId}
        <button
          type="button"
          onclick={() => goto('/profile')}
          title={m.nav_my_profile_title()}
          class="rounded-2xl ring-2 ring-transparent hover:ring-amber-400 transition-all duration-200"
          aria-label={m.nav_my_profile_label()}
        >
          <Avatar userId={globalSession.userId} size="sm" />
        </button>
      {/if}
    </div>
  </div>
</header>
