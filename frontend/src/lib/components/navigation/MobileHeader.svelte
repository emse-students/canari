<script lang="ts">
  import { goto } from '$app/navigation';
  import CanariBrand from './CanariBrand.svelte';
  import PostNotificationBell from './PostNotificationBell.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { m } from '$lib/paraglide/messages';
</script>

<!--
  Header mobile uniquement (md:hidden).
  Structure : spacer | logo centré | notifs + avatar
  Le spacer gauche a la même largeur que le groupe droit pour centrer le logo.
-->
<header
  class="md:hidden h-14 flex-shrink-0 flex items-center justify-between px-3
         bg-[var(--surface-elevated)] border-b border-cn-border backdrop-blur-sm z-20"
>
  <!-- Spacer gauche de même largeur que le groupe droit pour centrer le logo -->
  <div class="w-[4.5rem]"></div>

  <!-- Logo centré -->
  <a href="/posts" aria-label={m.nav_home_label()} class="flex items-center">
    <CanariBrand subtitle="" />
  </a>

  <!-- Actions droite : cloche + avatar -->
  <div class="flex items-center gap-1 w-[4.5rem] justify-end">
    {#if globalSession.isLoggedIn}
      <PostNotificationBell />
      {#if globalSession.userId}
        <button
          type="button"
          onclick={() => goto('/profile')}
          title={m.nav_my_profile_title()}
          aria-label={m.nav_my_profile_label()}
          class="rounded-2xl ring-2 ring-transparent hover:ring-amber-400 transition-all duration-200 ml-0.5"
        >
          <Avatar userId={globalSession.userId} size="sm" />
        </button>
      {/if}
    {/if}
  </div>
</header>
