<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { channelService, ChannelApiError } from '$lib/services/ChannelService';
  import { describeCommunityRefusal } from '$lib/utils/chat/communityErrors';
  import { openInvitedChannel } from '$lib/utils/chat/notificationRouting';
  import { currentUserId } from '$lib/stores/user';
  import { Users, Loader2, AlertCircle } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

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
      error = e instanceof Error ? e.message : m.invite_not_found();
    } finally {
      loading = false;
    }
  });

  async function join() {
    joining = true;
    error = '';
    try {
      const { workspaceSlug } = await channelService.acceptInvite(token);
      // Land IN the community that was just joined, not on a bare /communities where the sidebar
      // falls back to whichever community sorts first. Resolving the slug gives its first channel,
      // which is the deep-link target the notification machinery already knows how to open.
      const firstChannelId = await firstChannelOf(workspaceSlug);
      if (firstChannelId) {
        await openInvitedChannel(firstChannelId);
        return;
      }
      await goto('/communities', { replaceState: true });
    } catch (e) {
      // A link outliving its community is refused with a code rather than a sentence, so the
      // reason survives any rewording on the server side.
      const coded = e instanceof ChannelApiError ? describeCommunityRefusal(e.code) : null;
      error = coded ?? (e instanceof Error ? e.message : m.community_join_error_fallback());
      joining = false;
    }
  }

  /**
   * Landing channel of a workspace, or null when the lookup fails - a community with no channel
   * the caller may read is possible, and a failed resolution must not block a successful join.
   *
   * A public channel is preferred: the endpoint only returns channels the caller may read, but a
   * fresh joiner belongs in the community's open room rather than in whichever private channel
   * happens to sort first.
   */
  async function firstChannelOf(slug: string): Promise<string | null> {
    if (!slug) return null;
    try {
      const detail = await channelService.getWorkspaceBySlug(slug);
      const channels = detail?.channels ?? [];
      const target = channels.find((ch) => ch.visibility !== 'private') ?? channels[0];
      const channelId = target?.id ?? target?._id;
      return channelId ? String(channelId).replace(/^channel_/, '') : null;
    } catch {
      return null;
    }
  }
</script>

<svelte:head><title>{m.community_join_page_title()}</title></svelte:head>

<div class="px-4 py-10 max-w-md mx-auto">
  <div
    class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-8 shadow-sm text-center space-y-5"
  >
    {#if loading}
      <div class="flex justify-center py-6">
        <Loader2 size={28} class="animate-spin text-cn-yellow" />
      </div>
    {:else if error || !preview?.valid}
      <div class="flex flex-col items-center gap-3 py-4">
        <AlertCircle size={36} class="text-red-500" />
        <p class="text-sm font-semibold text-text-main">{m.invite_invalid_or_expired()}</p>
        {#if error}<p class="text-xs text-text-muted">{error}</p>{/if}
        <a href="/communities" class="text-sm font-semibold text-cn-dark hover:underline">
          {m.community_join_back()}
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
        <p class="text-sm text-text-muted">{m.community_join_invited_text()}</p>
        <h1 class="text-xl font-extrabold text-text-main mt-1">{preview.workspaceName}</h1>
      </div>
      <button
        type="button"
        onclick={join}
        disabled={joining}
        class="w-full rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50 transition-colors"
      >
        {joining ? m.common_connecting_label() : m.community_join_btn()}
      </button>
      <a href="/communities" class="block text-xs text-text-muted hover:text-text-main"
        >{m.common_cancel_button()}</a
      >
    {/if}
  </div>
</div>
