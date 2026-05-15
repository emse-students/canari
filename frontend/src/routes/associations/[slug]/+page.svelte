<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import {
    getAssociationBySlug,
    listMembers,
    followAssociation,
    unfollowAssociation,
    getAssociationFollowStatus,
    type Association,
    type AssociationMember,
  } from '$lib/associations/api';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { Bell, BellOff, Pencil, Building2, CalendarDays, Users } from 'lucide-svelte';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import AssociationMemberRow from '$lib/components/associations/AssociationMemberRow.svelte';
  import AssociationCalendarSection from '$lib/components/associations/AssociationCalendarSection.svelte';

  let asso = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let loading = $state(true);
  let error = $state('');
  let resolvedMemberNames = $state<Record<string, string>>({});

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((m) => m.userId === userId));
  let canManage = $derived(
    isGlobalAdmin() ||
      (!!myMembership &&
        (myMembership.permission === 1 ||
          myMembership.role === 'admin' ||
          myMembership.role === 'owner'))
  );

  let following = $state(false);
  let followLoading = $state(false);
  let activeSection = $state<'about' | 'calendar' | 'members'>('about');

  const slug = $derived((page.params as Record<string, string>).slug);


  onMount(loadData);

  async function loadData() {
    loading = true;
    error = '';
    try {
      asso = await getAssociationBySlug(slug);
      members = await listMembers(asso.id);
      const names: Record<string, string> = {};
      for (const m of members) {
        names[m.userId] = m.displayName?.trim() || getUserDisplayNameSync(m.userId, m.userId);
      }
      resolvedMemberNames = names;
      for (const m of members) {
        if (!m.displayName?.trim()) {
          resolveUserDisplayName(m.userId).then((resolved) => {
            if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [m.userId]: resolved };
          });
        }
      }
      const uid = currentUserId();
      if (uid) {
        try {
          const st = await getAssociationFollowStatus(asso.id);
          following = st.following;
        } catch {
          following = false;
        }
      } else {
        following = false;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Association introuvable';
    } finally {
      loading = false;
    }
  }

  async function toggleFollow() {
    if (!asso || !userId) return;
    followLoading = true;
    try {
      if (following) {
        await unfollowAssociation(asso.id);
        following = false;
      } else {
        await followAssociation(asso.id);
        following = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur';
    } finally {
      followLoading = false;
    }
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto space-y-8">
  <a href="/associations" class="text-sm text-text-muted hover:text-text-main transition-colors">
    ← Retour aux associations
  </a>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if error && !asso}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
  {:else if asso}
    <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-6 shadow-sm">
      <div class="flex items-start gap-4">
        {#if asso}
          <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
        {/if}
        <div class="flex-1 min-w-0">
          <h1 class="text-xl font-extrabold text-text-main tracking-tight truncate">{asso.name}</h1>
          <p class="text-sm text-text-muted">
            @{asso.slug} · {asso.memberCount ?? members.length} membre{(asso.memberCount ??
              members.length) !== 1
              ? 's'
              : ''}
          </p>
        </div>
        <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 shrink-0">
          {#if userId}
            <button
              type="button"
              onclick={() => toggleFollow()}
              disabled={followLoading}
              class="flex items-center justify-center gap-1.5 rounded-xl border border-cn-border px-3 py-2 text-sm font-medium text-text-main hover:bg-[var(--cn-surface)] transition-colors disabled:opacity-50"
            >
              {#if following}
                <BellOff size={16} />
                Ne plus suivre
              {:else}
                <Bell size={16} />
                Suivre
              {/if}
            </button>
          {/if}
          {#if canManage}
            <a
              href="/associations/{encodeURIComponent(slug)}/edit"
              class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-cn-yellow px-3 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors"
            >
              <Pencil size={16} />
              Modifier
            </a>
          {/if}
        </div>
      </div>
    </div>

    {#if error}
      <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
    {/if}

    <nav
      class="sticky top-0 z-30 -mx-4 px-4 py-3 bg-[var(--cn-bg)]/95 backdrop-blur-md border-y border-cn-border/80 sm:border sm:rounded-2xl sm:mx-0"
      aria-label="Sections de l'association"
    >
      <div class="flex gap-2 overflow-x-auto pb-1">
        <button
          type="button"
          onclick={() => (activeSection = 'about')}
          class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {activeSection === 'about'
            ? 'bg-cn-yellow text-cn-dark shadow-sm'
            : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
        >
          <Building2 size={17} />
          À propos
        </button>
        <button
          type="button"
          onclick={() => (activeSection = 'calendar')}
          class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {activeSection === 'calendar'
            ? 'bg-cn-yellow text-cn-dark shadow-sm'
            : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
        >
          <CalendarDays size={17} />
          Agenda
        </button>
        <button
          type="button"
          onclick={() => (activeSection = 'members')}
          class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {activeSection === 'members'
            ? 'bg-cn-yellow text-cn-dark shadow-sm'
            : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
        >
          <Users size={17} />
          Membres
        </button>
      </div>
    </nav>

    {#if activeSection === 'about'}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-6 space-y-4 shadow-sm">
        <h2 class="text-lg font-bold text-text-main tracking-tight">À propos</h2>
        {#if asso.description?.trim()}
          <p class="text-sm text-text-muted whitespace-pre-wrap">{asso.description}</p>
        {/if}
        {#if asso.bioMarkdown?.trim()}
          <div class="prose prose-neutral dark:prose-invert max-w-none">
            <SvelteMarkdown source={asso.bioMarkdown} options={{ gfm: true, breaks: true }} />
          </div>
        {:else if !asso.description?.trim()}
          <p class="text-sm text-text-muted">Aucune description pour le moment.</p>
        {/if}
      </div>
    {:else if activeSection === 'calendar'}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-6 shadow-sm">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h2 class="text-lg font-bold text-text-main tracking-tight">Agenda</h2>
          <a
            href="/calendar?association={encodeURIComponent(asso.id)}"
            class="text-xs font-semibold text-cn-dark hover:underline"
          >
            Voir dans l’agenda global →
          </a>
        </div>
        <AssociationCalendarSection
          associationId={asso.id}
          associationSlug={asso.slug}
          canEdit={canManage}
        />
      </div>
    {:else if activeSection === 'members'}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-6 space-y-4 shadow-sm">
        <h2 class="text-lg font-bold text-text-main tracking-tight">Membres</h2>
        <p class="text-sm text-text-muted">
          {members.length} personne{members.length !== 1 ? 's' : ''} dans cette association.
        </p>
        <div class="space-y-3">
          {#each members as member (member.id)}
            <AssociationMemberRow
              {member}
              displayName={resolvedMemberNames[member.userId] ?? member.displayName ?? member.userId}
            />
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
