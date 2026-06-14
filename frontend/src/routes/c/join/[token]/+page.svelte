<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { channelService } from '$lib/services/ChannelService';
  import { currentUserId } from '$lib/stores/user';
  import { Users, Loader2, AlertCircle } from '@lucide/svelte';

  const token = $derived((page.params as Record<string, string>).token);

  let loading = $state(true);
  let joining = $state(false);
  let error = $state('');
  let preview = $state<{
    valid: boolean;
    workspaceName: string | null;
    workspaceSlug: string | null;
    imageMediaId: string | null;
  } | null>(null);

  onMount(async () => {
    // Not authenticated yet: send to login, returning here afterwards (token is in the path).
    if (!currentUserId()) {
      await goto(`/login?returnTo=${encodeURIComponent(`/c/join/${token}`)}`, {
        replaceState: true,
      });
      return;
    }
    try {
      preview = await channelService.getInvitePreview(token);
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
      await channelService.acceptInvite(token);
      await goto('/communities', { replaceState: true });
    } catch (e) {
      error = e instanceof Error ? e.message : "Impossible de rejoindre la communauté";
      joining = false;
    }
  }
</script>

<svelte:head><title>Rejoindre une communauté - Canari</title></svelte:head>

<div class="px-4 py-10 max-w-md mx-auto">
  <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-8 shadow-sm text-center space-y-5">
    {#if loading}
      <div class="flex justify-center py-6">
        <Loader2 size={28} class="animate-spin text-cn-yellow" />
      </div>
    {:else if error || !preview?.valid}
      <div class="flex flex-col items-center gap-3 py-4">
        <AlertCircle size={36} class="text-red-500" />
        <p class="text-sm font-semibold text-text-main">Invitation invalide ou expirée</p>
        {#if error}<p class="text-xs text-text-muted">{error}</p>{/if}
        <a href="/communities" class="text-sm font-semibold text-cn-dark hover:underline">
          Retour aux communautés
        </a>
      </div>
    {:else}
      <div
        class="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-cn-yellow/10 text-cn-dark overflow-hidden"
      >
        {#if preview.imageMediaId}
          <img
            src="/api/media/public/{preview.imageMediaId}"
            alt=""
            class="h-full w-full object-cover"
          />
        {:else}
          <Users size={30} />
        {/if}
      </div>
      <div>
        <p class="text-sm text-text-muted">Vous avez été invité à rejoindre</p>
        <h1 class="text-xl font-extrabold text-text-main mt-1">{preview.workspaceName}</h1>
      </div>
      <button
        type="button"
        onclick={join}
        disabled={joining}
        class="w-full rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50 transition-colors"
      >
        {joining ? 'Connexion…' : 'Rejoindre la communauté'}
      </button>
      <a href="/communities" class="block text-xs text-text-muted hover:text-text-main">Annuler</a>
    {/if}
  </div>
</div>
