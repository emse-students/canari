<script lang="ts">
  /**
   * "MES ABONNES" (WP-F4): the reader's own followers, each removable, and the requests the reader
   * sent that nobody has answered yet, each withdrawable.
   *
   * Removing a follower tells nobody (decided 2026-10-25); they may ask again, and that new request
   * lands in the inbox. A row leaves its list on the tap and comes back if the write is refused -
   * the same shape as the blocked list in the settings.
   */
  import { onMount } from 'svelte';
  import { Send, UserCheck } from '@lucide/svelte';
  import ProfileCard from '$lib/components/profile/ProfileCard.svelte';
  import FollowPersonRow from '$lib/components/follows/FollowPersonRow.svelte';
  import {
    leaveFollow,
    listFollowers,
    listSentFollowRequests,
    removeFollower,
    type FollowListEntry,
  } from '$lib/follows/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { peekUserDisplayName } from '$lib/utils/users/displayName';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  let followers = $state<FollowListEntry[]>([]);
  let sent = $state<FollowListEntry[]>([]);
  let loading = $state(true);
  let error = $state('');
  /** The person whose removal or withdrawal is in flight. */
  let pendingId = $state<string | null>(null);

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      [followers, sent] = await Promise.all([listFollowers(), listSentFollowRequests()]);
      Log.d('ProfileFollowersSection', `followers=${followers.length} sent=${sent.length}`);
    } catch (e: unknown) {
      Log.d('ProfileFollowersSection.load failed', e);
      error = m.common_load_error();
    } finally {
      loading = false;
    }
  }

  async function handleRemove(userId: string) {
    const name = peekUserDisplayName(userId) ?? m.notif_actor_unknown();
    const confirmed = await showConfirm(m.profile_followers_remove_confirm({ name }), {
      danger: true,
      confirmLabel: m.profile_followers_remove(),
    });
    if (!confirmed) return;
    const previous = followers;
    followers = followers.filter((f) => f.userId !== userId);
    pendingId = userId;
    error = '';
    try {
      await removeFollower(userId);
    } catch (e: unknown) {
      Log.d('ProfileFollowersSection.remove failed', e);
      followers = previous;
      error = m.profile_followers_remove_error();
    } finally {
      pendingId = null;
    }
  }

  async function handleWithdraw(userId: string) {
    const previous = sent;
    sent = sent.filter((r) => r.userId !== userId);
    pendingId = userId;
    error = '';
    try {
      await leaveFollow(userId);
    } catch (e: unknown) {
      Log.d('ProfileFollowersSection.withdraw failed', e);
      sent = previous;
      error = m.profile_sent_requests_withdraw_error();
    } finally {
      pendingId = null;
    }
  }

  const buttonClass =
    'text-text-main shrink-0 rounded-lg bg-black/5 px-3 py-1.5 text-xs font-bold transition-colors hover:bg-black/10 disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/20';
</script>

{#if error}
  <p class="rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600">{error}</p>
{/if}

<ProfileCard icon={UserCheck} heading={m.profile_followers_heading()} {loading}>
  {#if !loading && followers.length === 0}
    <p class="text-text-muted text-sm font-medium">{m.profile_followers_empty()}</p>
  {:else}
    <ul class="space-y-2" data-followers-list>
      {#each followers as follower (follower.userId)}
        <FollowPersonRow userId={follower.userId} createdAt={follower.createdAt}>
          {#snippet actions()}
            <button
              type="button"
              class={buttonClass}
              disabled={pendingId === follower.userId}
              onclick={() => handleRemove(follower.userId)}
            >
              {m.profile_followers_remove()}
            </button>
          {/snippet}
        </FollowPersonRow>
      {/each}
    </ul>
  {/if}
</ProfileCard>

<ProfileCard icon={Send} heading={m.profile_sent_requests_heading()} {loading}>
  {#if !loading && sent.length === 0}
    <p class="text-text-muted text-sm font-medium">{m.profile_sent_requests_empty()}</p>
  {:else}
    <ul class="space-y-2" data-sent-requests-list>
      {#each sent as request (request.userId)}
        <FollowPersonRow userId={request.userId} createdAt={request.createdAt}>
          {#snippet actions()}
            <button
              type="button"
              class={buttonClass}
              disabled={pendingId === request.userId}
              onclick={() => handleWithdraw(request.userId)}
            >
              {m.profile_sent_requests_withdraw()}
            </button>
          {/snippet}
        </FollowPersonRow>
      {/each}
    </ul>
  {/if}
</ProfileCard>
