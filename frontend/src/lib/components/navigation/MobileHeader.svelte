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
  class="border-cn-border z-20 flex h-14 flex-shrink-0 items-center justify-between
         border-b bg-(--surface-elevated) px-3 backdrop-blur-sm md:hidden"
>
  <!-- Spacer gauche de même largeur que le groupe droit pour centrer le logo -->
  <div class="w-[4.5rem]"></div>

  <!-- Logo centré -->
  <a href="/posts" aria-label={m.nav_home_label()} class="flex items-center">
    <CanariBrand subtitle="" />
  </a>

  <!-- Actions droite : cloche + avatar -->
  <div class="flex w-[4.5rem] items-center justify-end gap-1">
    {#if globalSession.isLoggedIn}
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
