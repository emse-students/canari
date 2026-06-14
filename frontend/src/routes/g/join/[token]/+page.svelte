<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getGroupInvitePreview, acceptGroupInvite } from '$lib/mls/groupInvites';
  import { currentUserId } from '$lib/stores/user';
  import { Users, Loader2, AlertCircle, Check } from '@lucide/svelte';

  const token = $derived((page.params as Record<string, string>).token);

  let loading = $state(true);
  let joining = $state(false);
  let joined = $state(false);
  let error = $state('');
  let preview = $state<{ valid: boolean; groupId: string | null; groupName: string | null } | null>(
    null
  );

  onMount(async () => {
    if (!currentUserId()) {
      await goto(`/login?returnTo=${encodeURIComponent(`/g/join/${token}`)}`, {
        replaceState: true,
      });
      return;
    }
    try {
      preview = await getGroupInvitePreview(token);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Invitation introuvable';
    } finally {
      loading = false;
    }
  });

  async function join() {
    joining = true;
    error = '';
    try {
      await acceptGroupInvite(token);
      joined = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Impossible de rejoindre le groupe';
      joining = false;
    }
  }
</script>

<svelte:head><title>Rejoindre un groupe - Canari</title></svelte:head>

<div class="px-4 py-10 max-w-md mx-auto">
  <div
    class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-8 shadow-sm text-center space-y-5"
  >
    {#if loading}
      <div class="flex justify-center py-6">
        <Loader2 size={28} class="animate-spin text-cn-yellow" />
      </div>
    {:else if joined}
      <div class="flex flex-col items-center gap-3 py-2">
        <div class="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
          <Check size={30} />
        </div>
        <p class="text-sm font-semibold text-text-main">Demande envoyée !</p>
        <p class="text-xs text-text-muted leading-relaxed">
          Vous rejoindrez « {preview?.groupName ?? 'le groupe'} » dès qu'un de ses membres sera en
          ligne. La conversation apparaîtra automatiquement dans votre messagerie.
        </p>
        <a
          href="/chat"
          class="mt-1 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-colors"
        >
          Aller à la messagerie
        </a>
      </div>
    {:else if error || !preview?.valid}
      <div class="flex flex-col items-center gap-3 py-4">
        <AlertCircle size={36} class="text-red-500" />
        <p class="text-sm font-semibold text-text-main">Invitation invalide ou expirée</p>
        {#if error}<p class="text-xs text-text-muted">{error}</p>{/if}
        <a href="/chat" class="text-sm font-semibold text-cn-dark hover:underline">
          Retour à la messagerie
        </a>
      </div>
    {:else}
      <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-cn-yellow/10 text-cn-dark">
        <Users size={30} />
      </div>
      <div>
        <p class="text-sm text-text-muted">Vous avez été invité à rejoindre le groupe</p>
        <h1 class="text-xl font-extrabold text-text-main mt-1">
          {preview.groupName ?? 'Groupe Canari'}
        </h1>
      </div>
      <button
        type="button"
        onclick={join}
        disabled={joining}
        class="w-full rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50 transition-colors"
      >
        {joining ? 'Envoi…' : 'Rejoindre le groupe'}
      </button>
      <a href="/chat" class="block text-xs text-text-muted hover:text-text-main">Annuler</a>
    {/if}
  </div>
</div>
