<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import { onMount } from 'svelte';
  import { signOutByChoice } from '$lib/stores/auth';
  import { currentUserId, getSavedDisplayName, isGlobalAdmin } from '$lib/stores/user';
  import { ensureMyAssociations, getReviewerAccess, type Association } from '$lib/associations/api';
  import { adminScopeLabels, ensureMayOpenAdmin } from '$lib/admin/access';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import { dashboardHubGroups } from '$lib/navigation/dashboardSections';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  // THE APP'S ONE HUB (`dashboardSections.ts` is the table). Identity, Explorer and Compte render on
  // the first frame from what is already held - sign-out is reachable whatever a probe does. The
  // probed groups wait for EVERY probe to settle (`allSettled`: a failure settles too) and are then
  // inserted above Compte with NO space reserved, so Compte can only move DOWN (manager, staff) and
  // never for a member; a probe that never answers leaves only a screen-reader status.
  let mayOpenAdmin = $state(false);
  let isReviewer = $state(false);
  let memberships = $state<Association[]>([]);
  let probesSettled = $state(false);

  onMount(() => {
    Log.d('[dashboard] mount: probing memberships, admin tier and reviewer access');
    // The unread count is the store's. Its only other loader is the bell, mounted on the Feed
    // alone on a phone, so a cold open here would show no count and a later visit a stale one.
    // `load()` drops a call while one is in flight; no timer of our own.
    void postNotifStore.load();
    void Promise.allSettled([
      // Reviewer access is independent of association status (external school/MDE staff).
      getReviewerAccess().then((v) => (isReviewer = v)),
      // ONE membership request, memoized: `ensureMayOpenAdmin` awaits the same promise for any
      // reader who is not a platform admin.
      ensureMyAssociations().then((list) => (memberships = list)),
      // The SAME predicate `/admin` admits on, so no console is offered that would refuse its reader.
      ensureMayOpenAdmin().then((v) => (mayOpenAdmin = v)),
    ]).then((results) => {
      // A failed probe hides only what it gates (its state keeps its `false` / `[]` default).
      for (const [i, r] of results.entries()) {
        if (r.status === 'rejected') {
          const probe = ['reviewer access', 'memberships', 'admin tier'][i];
          console.warn(
            `[dashboard] ${probe} probe failed, the rows it gates stay hidden`,
            r.reason
          );
        }
      }
      Log.d('[dashboard] probes settled', { mayOpenAdmin, isReviewer, n: memberships.length });
      probesSettled = true;
    });
  });

  const groups = $derived(
    dashboardHubGroups(
      {
        userId: currentUserId(),
        displayName: getSavedDisplayName(),
        unreadNotifications: postNotifStore.unread,
        mayOpenAdmin,
        adminScope: adminScopeLabels(isGlobalAdmin()),
        isReviewer,
        memberships,
        probesSettled,
      },
      { signOut: () => void signOutByChoice() }
    )
  );
</script>

<PageContainer>
  <PageHeader title={m.nav_dashboard_label()} subtitle={m.dashboard_subtitle()} />
  <div class="space-y-6">
    {#each groups as group (group.key)}
      {#if group.key === 'account' && !probesSettled}
        {@render pending()}
      {/if}
      <section class="space-y-2" aria-labelledby={group.heading ? `group-${group.key}` : undefined}>
        {#if group.heading}
          <h2
            id="group-{group.key}"
            class="text-text-muted scroll-mt-4 px-1 text-xs font-bold tracking-wide uppercase"
          >
            {group.label}
          </h2>
        {/if}
        <SectionHub rows={group.rows} label={group.label} />
      </section>
    {/each}
  </div>
</PageContainer>

{#snippet pending()}
  <!-- The probed groups (managed associations, administration, documents) are still being asked
       for. NOTHING IS RESERVED: a reserved row collapsed for the commonest reader (a member, who
       gets no probed group) and Compte jumped UP, bringing sign-out under a finger aimed at
       settings. With no height here, a probed group can only push Compte DOWN, and only for a
       manager or staff. Out of the flow (`sr-only`): a status for assistive technology alone. -->
  <span data-dashboard-pending role="status" class="sr-only">{m.common_loading_label()}</span>
{/snippet}
