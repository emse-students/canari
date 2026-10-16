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

  // THE APP'S ONE HUB (`dashboardSections.ts` is the table). Identity and Explorer render on the
  // first frame from what is already held. Everything below them waits for ALL the probes, with a
  // placeholder holding its place, so no row slides under a finger as each answer arrives.
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
    void Promise.all([
      // Reviewer access is independent of association status (external school/MDE staff).
      getReviewerAccess()
        .then((v) => (isReviewer = v))
        .catch((err) => {
          console.warn('[dashboard] reviewer access probe failed, Documents row hidden', err);
          isReviewer = false;
        }),
      // ONE membership request, memoized: `ensureMayOpenAdmin` awaits the same promise for any
      // reader who is not a platform admin. The probe logs and answers `[]` on its own failure.
      ensureMyAssociations().then((list) => (memberships = list)),
      // The SAME predicate `/admin` admits on, so no console is offered that would refuse its reader.
      ensureMayOpenAdmin().then((v) => (mayOpenAdmin = v)),
    ]).then(() => {
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
    {#if !probesSettled}
      <!-- The place of the groups the probes decide: a heading and two rows, the least every
           reader gets (Compte: settings, sign-out). Nothing in it can be tapped. -->
      <div data-dashboard-pending aria-hidden="true" class="animate-pulse space-y-2">
        <div class="bg-cn-border mx-1 h-3 w-24 rounded-full"></div>
        <div
          class="border-cn-border bg-cn-surface divide-cn-border divide-y overflow-hidden rounded-2xl border"
        >
          {#each [0, 1] as i (i)}
            <div class="flex items-center gap-3 px-4 py-3.5">
              <div class="bg-cn-border size-5 rounded-full"></div>
              <div class="flex-1 space-y-1.5">
                <div class="bg-cn-border h-3 w-1/3 rounded-full"></div>
                <div class="bg-cn-border h-2.5 w-1/2 rounded-full"></div>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</PageContainer>
