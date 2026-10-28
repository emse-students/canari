<script lang="ts">
  import { internalPath } from '$lib/utils/internalPath';
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import SpaceEditor from '$lib/components/bookings/organiser/SpaceEditor.svelte';
  import { getManagedSpace, type ManagedSpace } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { BOOKINGS_HREF, spaceEditorHref } from '$lib/bookings/routes';
  import { getAssociation, type Association, type MembershipTier } from '$lib/associations/api';
  import { editSectionHref } from '$lib/associations/editSections';
  import { cotisationOptionsFor } from '$lib/forms/cotisationSettings';
  import { fetchFormations, type FormationOption } from '$lib/pricing/criteriaOptions';
  import { setPageTitle } from '$lib/seo/pageTitle.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * The organiser's page of one space (WP-B4): loads it, and the owning entity's name, tiers and
   * the formations its conditions name; the editing is `SpaceEditor`'s. The server holds every
   * right: a reader who may not manage the space is answered `not-manager` and reads that.
   */

  const spaceId = $derived(page.params.spaceId ?? '');

  let space = $state<ManagedSpace | null>(null);
  let owner = $state<Association | null>(null);
  let tiers = $state<MembershipTier[]>([]);
  let formations = $state<FormationOption[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  /** Where this space belongs: its entity's bookings tab, or the Reservations page for a personal one. */
  const ownerHref = $derived(
    owner
      ? editSectionHref(
          owner.slug,
          'reservations',
          owner.type === 'list' ? '/lists' : '/associations'
        )
      : null
  );
  const crumbs = $derived.by(() => {
    if (!space) return undefined;
    const here = { label: space.name, href: spaceEditorHref(space.id) };
    if (space.associationId === null) {
      return [{ label: m.bookings_page_title(), href: BOOKINGS_HREF }, here];
    }
    return owner && ownerHref ? [{ label: owner.name, href: ownerHref }, here] : undefined;
  });

  $effect(() => {
    if (!space) return;
    setPageTitle(space.name);
    return () => setPageTitle(null);
  });

  // The route parameter, not the mount: SvelteKit keeps this page alive from one space's editor to
  // another's, so each new id is a new load.
  $effect(() => {
    const id = spaceId;
    untrack(() => void load(id));
  });

  async function load(id: string) {
    Log.d('BOOKINGS', `editor load space=${id}`);
    loading = true;
    loadError = '';
    space = null;
    owner = null;
    tiers = [];
    try {
      const loaded = await getManagedSpace(id);
      // A later navigation owns the page now: this answer is for a space no longer shown.
      if (id !== spaceId) return;
      space = loaded;
      if (loaded.associationId) {
        const assoc = loaded.associationId;
        void getAssociation(assoc)
          .then((a) => {
            if (id === spaceId) owner = a;
          })
          .catch((e) => Log.d('BOOKINGS', `owner name unavailable: ${String(e)}`));
        void cotisationOptionsFor(assoc).then((o) => {
          if (id === spaceId) tiers = o.tiers;
        });
      }
      fetchFormations()
        .then((f) => (formations = f))
        .catch((e) => Log.d('BOOKINGS', `formations unavailable: ${String(e)}`));
    } catch (e) {
      if (id !== spaceId) return;
      loadError = describeBookingRefusal(e, m.common_load_error());
    } finally {
      if (id === spaceId) loading = false;
    }
  }

  /** Back to the entity's bookings tab once the space is gone, or to Reservations for a personal one. */
  async function leave() {
    if (owner?.type === 'list') {
      await goto(resolve(internalPath(editSectionHref(owner.slug, 'reservations', '/lists'))));
    } else if (owner) {
      await goto(resolve(internalPath(editSectionHref(owner.slug, 'reservations'))));
    } else {
      await goto(resolve(BOOKINGS_HREF));
    }
  }
</script>

<PageContainer width="tool">
  <PageHeader
    title={space?.name ?? m.bookings_editor_title()}
    subtitle={space ? m.bookings_editor_title() : undefined}
    {crumbs}
  />

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if loadError || !space}
    <p
      class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm"
      role="alert"
    >
      {loadError}
    </p>
  {:else}
    {#key space.id}
      <SpaceEditor
        initial={space}
        {tiers}
        {formations}
        onSaved={(saved) => space && (space.name = saved.name)}
        onDeleted={leave}
      />
    {/key}
  {/if}
</PageContainer>
