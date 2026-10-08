<script lang="ts">
  import { resolve } from '$app/paths';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import Breadcrumb from '$lib/components/navigation/Breadcrumb.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    isGlobalAdmin,
    isAssociationSuperAdmin,
    isContentModerator,
    isEventValidator,
  } from '$lib/stores/user';
  import { adminScopeLabels, ensureMayOpenAdmin } from '$lib/admin/access';
  import { adminTrail, mayOpenAdminPath, type AdminTiers } from '$lib/admin/adminSections';
  import { Shield, ArrowLeft } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let { children } = $props();

  let ready = $state(false);
  let isGlobalAdminUser = $state(false);
  let isSuperAdminUser = $state(false);
  let isModeratorUser = $state(false);
  let isEventValidatorUser = $state(false);

  const path = $derived(page.url.pathname);
  // The heading and the sentence under it, chosen together - see `adminScopeLabels`.
  const scope = $derived(adminScopeLabels(isGlobalAdminUser));

  onMount(async () => {
    // The SAME predicate the dashboard offers the card on, so the door and the way in cannot
    // disagree again. It awaits the membership probe, which publishes both BDE tiers as a side
    // effect - the redirect must decide on a resolved value, since a background probe would bounce
    // a moderator to the dashboard whenever it lost the race.
    const mayOpen = await ensureMayOpenAdmin();
    isGlobalAdminUser = isGlobalAdmin();
    if (isGlobalAdminUser) {
      // A platform administrator holds every tier by definition; nothing to ask anyone.
      isSuperAdminUser = true;
      isModeratorUser = true;
      isEventValidatorUser = true;
    } else {
      isSuperAdminUser = isAssociationSuperAdmin();
      isModeratorUser = isContentModerator();
      isEventValidatorUser = isEventValidator();
    }
    ready = true;
    if (!mayOpen) {
      void goto(resolve('/dashboard'), { replaceState: true });
    }
  });

  const tiers = $derived<AdminTiers>({
    isGlobalAdmin: isGlobalAdminUser,
    isSuperAdmin: isSuperAdminUser,
    isModerator: isModeratorUser,
    isEventValidator: isEventValidatorUser,
  });
  // THE LAYOUT IS THE AUTHORITY on which page renders: a typed URL for a page this tier cannot
  // open is sent to the hub, whatever the page itself checks. The hub lists only what `tiers` may
  // open, so a refused path is exactly one the reader was never shown.
  const allowed = $derived(ready && mayOpenAdminPath(path, tiers));
  const isHub = $derived(path === '/admin' || path === '/admin/');
  const trail = $derived(isHub ? undefined : adminTrail(path, scope.title()));

  $effect(() => {
    if (!ready || allowed) return;
    console.warn('[ADMIN] path not open to this tier, redirecting to the hub:', path);
    void goto(resolve('/admin'), { replaceState: true });
  });
</script>

{#if !ready}
  <div class="flex justify-center py-24">
    <div
      class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
    ></div>
  </div>
{:else}
  <!-- THE ADMIN CONSOLE IS ONE PAGE SHAPE, AND IT IS THE SHARED ONE.
       This was `mx-auto max-w-4xl` with its own padding - a FOURTH width, outside the three
       `pageWidth.ts` allows, applied to all eleven admin pages at once. It did not merely differ:
       being an ancestor of every page it CLAMPED them, so `/admin/status` asked for the 1024px
       editor measure and was drawn at 896 with nothing reporting it. Measured 2026-09-10, at
       1440px: eleven pages, eleven times 896.
       `tool` and not `reading`, because every one of them is a table or a board rather than a
       column of prose. The three pages that declared their own container no longer do - one
       column per page, and the layout owns it here because the header above is part of it.

       NAVIGATION IS DEPTH, NOT A STRIP (user, 2026-10-08): the hub at `/admin` lists the pages by
       group, a page shows its path (`Admin > Group > Page`), and there is no row of links or
       dropdown to scroll or open. -->
  <PageContainer width="tool" class="space-y-6">
    {#if isHub}
      <a
        href={resolve('/dashboard')}
        class="tap-target text-text-muted hover:text-text-main inline-flex items-center gap-1 text-sm transition-colors"
      >
        <ArrowLeft size={14} />
        {m.admin_dashboard_link()}
      </a>

      <header class="flex items-start gap-3">
        <span
          class="bg-cn-yellow/20 text-cn-dark flex h-11 w-11 items-center justify-center rounded-2xl"
        >
          <Shield size={22} />
        </span>
        <div>
          <h1 class="text-text-main text-xl font-bold tracking-tight">{scope.title()}</h1>
          <p class="text-text-muted mt-0.5 text-sm">{scope.description()}</p>
        </div>
      </header>
    {:else if trail}
      <Breadcrumb crumbs={trail} />
    {/if}

    {#if allowed}
      {@render children?.()}
    {/if}
  </PageContainer>
{/if}
