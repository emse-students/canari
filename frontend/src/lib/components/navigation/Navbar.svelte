<script lang="ts">
  import StatusPill from '../shared/StatusPill.svelte';
  import CanariBrand from './CanariBrand.svelte';
  import SessionActionButtons from './SessionActionButtons.svelte';
  import Avatar from '../shared/Avatar.svelte';
  import { goto } from '$app/navigation';
  import { clearAuth } from '$lib/stores/auth';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';

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
      <SessionActionButtons onLogout={handleLogout} />
      {#if globalSession.isLoggedIn && globalSession.userId}
        <button
          type="button"
          onclick={() => goto('/profile')}
          title="Mon profil"
          class="rounded-2xl ring-2 ring-transparent hover:ring-amber-400 transition-all duration-200"
          aria-label="Accéder au profil"
        >
          <Avatar userId={globalSession.userId} size="sm" />
        </button>
      {/if}
    </div>
  </div>
</header>
