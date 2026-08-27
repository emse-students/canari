<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { channelService, ChannelApiError } from '$lib/services/ChannelService';
  import { describeCommunityRefusal } from '$lib/utils/chat/communityErrors';
  import { openInvitedChannel } from '$lib/utils/chat/notificationRouting';
  import { currentUserId } from '$lib/stores/user';
  import { apiAssetUrl } from '$lib/utils/apiUrl';
  import { Users, LoaderCircle, CircleAlert } from '@lucide/svelte';
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

<div class="mx-auto max-w-md px-4 py-10">
  <div
    class="border-cn-border space-y-5 rounded-2xl border bg-(--cn-surface) p-8 text-center shadow-sm"
  >
    {#if loading}
      <div class="flex justify-center py-6">
        <LoaderCircle size={28} class="text-cn-yellow animate-spin" />
      </div>
    {:else if error || !preview?.valid}
      <div class="flex flex-col items-center gap-3 py-4">
        <CircleAlert size={36} class="text-red-500" />
        <p class="text-text-main text-sm font-semibold">{m.invite_invalid_or_expired()}</p>
        {#if error}<p class="text-text-muted text-xs">{error}</p>{/if}
        <a href="/communities" class="text-cn-dark text-sm font-semibold hover:underline">
          {m.community_join_back()}
        </a>
      </div>
    {:else}
      <div
        class="bg-cn-yellow/10 text-cn-dark mx-auto flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl"
      >
        {#if preview.imageMediaId}
          <img
            src={apiAssetUrl(`/api/media/public/${preview.imageMediaId}`)}
            alt=""
            class="h-full w-full object-cover"
          />
        {:else}
          <Users size={30} />
        {/if}
      </div>
      <div>
        <p class="text-text-muted text-sm">{m.community_join_invited_text()}</p>
        <h1 class="text-text-main mt-1 text-xl font-extrabold">{preview.workspaceName}</h1>
      </div>
      <button
        type="button"
        onclick={join}
        disabled={joining}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover w-full rounded-xl px-5 py-2.5 text-sm font-bold transition-colors disabled:opacity-50"
      >
        {joining ? m.common_connecting_label() : m.community_join_btn()}
      </button>
      <a href="/communities" class="text-text-muted hover:text-text-main block text-xs"
        >{m.common_cancel_button()}</a
      >
    {/if}
  </div>
</div>
