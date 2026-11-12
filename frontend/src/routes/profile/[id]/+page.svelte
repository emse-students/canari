<script lang="ts">
  import { intlLocale } from '$lib/utils/intlLocale';
  import { resolve } from '$app/paths';
  import ProfileSummaryLine from '$lib/components/profile/ProfileSummaryLine.svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { untrack } from 'svelte';
  import {
    fetchUserProfile,
    isAbsentUserError,
    type UserProfile,
    getSavedUserId,
  } from '$lib/stores/user';
  import { forgetProfileCopy, readProfileCopy, rememberProfile } from '$lib/profile/profileCopies';
  import { localCopiesOpenFor } from '$lib/localCopies/localCopyStore.svelte';
  import { PROFILE_SELF_SEGMENT } from '$lib/profile/profileSections';
  import { getFollowStatus, type FollowStatus } from '$lib/follows/api';
  import {
    askPerson,
    followEpoch,
    leavePerson,
    recordPersonStatus,
    withdrawPerson,
  } from '$lib/follows/followState.svelte';
  import FollowAlsoSuggestions from '$lib/components/suggestions/FollowAlsoSuggestions.svelte';
  import AccountBell from '$lib/components/follows/AccountBell.svelte';
  import {
    describeFollowRefusal,
    followActionOf,
    followLabel,
    optimisticStatusAfter,
  } from '$lib/follows/followButton';
  import { refusalCode } from '$lib/utils/apiRefusal';
  import { listBlockedUsers, blockUser, unblockUser } from '$lib/users/blocks';
  import { createReport, ModerationApiError } from '$lib/moderation/api';
  import type { ReportReason } from '$lib/moderation/reasons';
  import ReportReasonDialog from '$lib/components/moderation/ReportReasonDialog.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Log } from '$lib/utils/Log';
  import { requestDirectConversationWith } from '$lib/utils/chat/pendingChatOpening';
  import ProfileHeader from '$lib/components/profile/ProfileHeader.svelte';
  import ProfileOverflowMenu from '$lib/components/profile/ProfileOverflowMenu.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import {
    GraduationCap,
    CalendarDays,
    LoaderCircle,
    CircleAlert,
    MessageCircle,
    UserPlus,
    UserCheck,
    UserRoundCheck,
    Users,
  } from '@lucide/svelte';
  import { slide, fade } from 'svelte/transition';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import ProfileAssociationsSection from '$lib/components/profile/ProfileAssociationsSection.svelte';
  import ProfileRoleHistorySection from '$lib/components/profile/ProfileRoleHistorySection.svelte';
  import ProfileParrainageSection from '$lib/components/profile/ProfileParrainageSection.svelte';
  import ProfileMinesweeperBadge from '$lib/components/profile/ProfileMinesweeperBadge.svelte';
  import type { UserMembershipRow, UserRoleHistoryRow, SkyEntourage } from '$lib/profile/api';
  import { readProfileWithExtras } from '$lib/profile/profileExtras';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { Building2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let profile = $state<UserProfile | null>(null);
  let loading = $state(true);
  /**
   * What is on screen is the device's COPY of this profile (slow-link chantier, gap 2), drawn before
   * the read answers. It holds no verdict about the reader, so the follow and block gestures wait
   * for the answer.
   */
  let fromCopy = $state(false);
  /** The server ANSWERED that this account is gone: the only failure that withholds a copy. */
  let absent = $state(false);
  let error = $state('');
  /** Where the reader stands with this person: a request, a follow, or neither (WP-F4). */
  let followStatus = $state<FollowStatus | null>(null);
  let followLoading = $state(false);
  /** The person the reader followed or asked on THIS visit: "Suivez aussi..." follows it (WP-6). */
  let followedHereId = $state<string | null>(null);
  let memberships = $state<UserMembershipRow[]>([]);
  let roleHistory = $state<UserRoleHistoryRow[]>([]);
  let parrainage = $state<SkyEntourage | null>(null);
  let extrasLoading = $state(false);
  /** True when the signed-in user has blocked the person whose profile this is. */
  let blocked = $state(false);
  let blockLoading = $state(false);
  let reportOpen = $state(false);
  let reportSubmitting = $state(false);
  /** Inline feedback for the report and block actions, cleared on the next attempt. */
  let actionMessage = $state('');

  // Monotonic token guarding against out-of-order async results: when the user navigates
  // between two profiles quickly, a slower earlier fetch must not overwrite the newer one.
  let loadToken = 0;

  /** Loads a profile and its extras, ignoring the result if a newer load has since started. */
  async function loadProfile(userId: string, token: number) {
    const readAt = followEpoch();
    // THE EXTRAS LEAVE WITH THE PROFILE, NOT AFTER IT (`readProfileWithExtras`): they used to wait
    // for the profile's answer and then for each other. They are APPLIED once the profile is in.
    const { profile: profileRead, extras } = readProfileWithExtras(userId, () =>
      Promise.all([
        fetchUserProfile(userId),
        getFollowStatus(userId)
          .then((read) => {
            // The ledger learns what this page read (a chip elsewhere agrees with it) - unless the
            // reader changed while it was out.
            recordPersonStatus(userId, read, readAt);
            return read;
          })
          .catch((e: unknown) => {
            Log.d('profile.loadFollowStatus failed', e);
            return null;
          }),
        // A blocked person is hidden from search but their profile stays reachable - by url, or
        // from the blocked list itself - so this page has to know, or it would offer to block
        // somebody who already is.
        listBlockedUsers().catch((e) => {
          Log.d('profile.loadBlocks failed', e);
          return [];
        }),
      ])
    );
    try {
      const [prof, status, blocks] = await profileRead;
      if (token !== loadToken) return;
      // The copy's lists are on screen: a section whose read FAILED keeps them (typed, not `[]`).
      const heldCopy = fromCopy;
      profile = prof;
      fromCopy = false;
      followStatus = status;
      blocked = blocks.some((b) => b.userId === userId);
      extrasLoading = true;
      const [rows, history, entourage] = await Promise.all([
        extras.memberships.then((r) => {
          if (token === loadToken && (r.answered || !heldCopy)) memberships = r.value;
          return r;
        }),
        extras.roleHistory.then((r) => {
          if (token === loadToken && (r.answered || !heldCopy)) roleHistory = r.value;
          return r;
        }),
        extras.parrainage.then((r) => {
          if (token === loadToken) parrainage = r.value;
          return r;
        }),
      ]);
      Log.d(
        'profile.extras',
        `${rows.value.length} membership(s), ${history.value.length} role(s), entourage ${entourage.value ? 'read' : 'none'}`
      );
      if (token === loadToken) extrasLoading = false;
      // Kept for the next visit, whatever the link: sealed on the device, never in clear. The lists
      // are those ON SCREEN; with no copy behind them and a failed section there is nothing true to
      // seal, so nothing is.
      if (token === loadToken && ((rows.answered && history.answered) || heldCopy)) {
        void rememberProfile({
          profile: prof,
          memberships: $state.snapshot(memberships),
          roleHistory: $state.snapshot(roleHistory),
        });
      }
    } catch (err) {
      Log.d('profile.load failed', err);
      if (token !== loadToken) return;
      if (fromCopy && !isAbsentUserError(err)) {
        // THE COPY STAYS: a failed revalidation says nothing about the profile. Logged, not shown.
        console.warn(
          `[PROFILE-COPIES] ${userId.slice(0, 8)} not refreshed, the device copy stays: ${String(err)}`
        );
        extrasLoading = false;
        return;
      }
      if (isAbsentUserError(err)) {
        // An ANSWER: the account is gone, its copy goes with it.
        forgetProfileCopy(userId);
        absent = true;
        fromCopy = false;
        profile = null;
      }
      error = m.profile_public_load_error();
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  // Reactively (re)load whenever the [id] route param changes. onMount would only fire on the
  // first mount - navigating /profile/[a] -> /profile/[b] reuses this same component instance,
  // so an effect on page.params.id is what makes the page actually re-render on the new user.
  $effect(() => {
    const userId = page.params.id;

    // A new target invalidates any in-flight load and resets the visible state so the previous
    // profile's content is never shown while the new one loads.
    const token = ++loadToken;
    profile = null;
    fromCopy = false;
    error = '';
    absent = false;
    memberships = [];
    roleHistory = [];
    parrainage = null;
    extrasLoading = false;
    loading = true;

    if (!userId) {
      error = m.profile_public_missing_id();
      loading = false;
      return;
    }

    // Redirect to own profile page if viewing self.
    const currentUserId = getSavedUserId();
    // `me` is the segment of the reader's own sections (`/profile/me/<section>`), never a user id:
    // a typed `/profile/me` is the reader's own profile too.
    if (userId === PROFILE_SELF_SEGMENT || (currentUserId && userId === currentUserId)) {
      goto(resolve('profile'), { replace: true });
      return;
    }

    void loadProfile(userId, token);
  });

  /**
   * DRAWS THE PROFILE FROM THE DEVICE while its read is on the wire (slow-link chantier, gap 2).
   * Re-runs when the device's copies open (the key may arrive after the first frame). Never over
   * anything already drawn - an answer that won the race is newer. ONLY AN ANSWER (the account is
   * gone) withholds it: a transport failure that lands before the slower copy read must not beat it
   * (the feed's `storedCopyMayDraw` rule), offline being the case the copy exists for.
   */
  $effect(() => {
    const userId = page.params.id;
    const open = localCopiesOpenFor();
    if (!userId || !open) return;
    const token = untrack(() => loadToken);
    if (untrack(() => profile !== null || absent)) return;
    let cancelled = false;
    void readProfileCopy(userId).then((copy) => {
      if (cancelled || !copy || token !== loadToken || profile !== null || absent) return;
      profile = copy.profile;
      memberships = copy.memberships;
      roleHistory = copy.roleHistory;
      fromCopy = true;
      loading = false;
      extrasLoading = false;
      error = '';
      Log.d('profile.copy', `${userId.slice(0, 8)} drawn from the device, no network`);
    });
    return () => {
      cancelled = true;
    };
  });

  function formatYear(year: number | null): string {
    if (!year) return m.profile_promo_unknown();
    return m.profile_promo_value({ year });
  }

  const displayFallbackName = $derived.by(() => {
    if (profile?.displayName) return profile.displayName;
    if (profile?.id) return getUserDisplayNameSync(profile.id, m.profile_public_default_name());
    return m.profile_public_default_name();
  });

  function handleSendMessage() {
    // A PERSON, not a conversation: the chat page finds the DM with them or creates it
    // (`pendingChatOpening.ts`). Handed over as a conversation key, this user id opened nothing.
    if (!profile?.id) return;
    // The ask names who made it, so an account signed in after this tap never acts on it.
    const owner = getSavedUserId();
    if (!owner) {
      console.warn('[PROFILE] "Message" pressed with no signed-in account - nothing is asked');
      return;
    }
    Log.d('[PROFILE] "Message": asking the chat page for the DM with this person');
    requestDirectConversationWith(owner, profile.id, sessionStorage);
    goto(resolve('/chat'));
  }

  /**
   * Asks, withdraws or unfollows, by where the reader stands (`followButton.ts`). Unfollowing asks
   * first: every personal account is private, so following again means asking again.
   */
  async function handleFollowToggle() {
    if (!profile?.id || followLoading) return;
    const action = followActionOf(followStatus);
    if (action === 'unfollow') {
      const confirmed = await showConfirm(
        m.profile_unfollow_confirm({ name: displayFallbackName }),
        {
          confirmLabel: m.profile_unfollow_confirm_btn(),
        }
      );
      if (!confirmed) return;
    }
    // THE LABEL FLIPS ON THE TAP. It used to flip after the round trip while `followLoading` held
    // the button disabled, so on a bad link the reader pressed "Suivre", got a dead control, and
    // had nothing to read for seconds. A refusal puts it back and says why.
    const was = followStatus;
    followStatus = optimisticStatusAfter(action);
    followLoading = true;
    actionMessage = '';
    Log.d('profile.handleFollowToggle', `${action} from ${was ?? 'none'}`);
    try {
      if (action === 'ask') {
        followStatus = await askPerson(profile.id);
        followedHereId = profile.id;
      }
      // A withdraw answers where the pair stands NOW: a request accepted meanwhile stays a follow.
      else if (action === 'withdraw') followStatus = await withdrawPerson(profile.id);
      else await leavePerson(profile.id);
    } catch (err) {
      Log.d('profile.handleFollowToggle failed', err);
      followStatus = was;
      actionMessage = describeFollowRefusal(refusalCode(err));
    } finally {
      followLoading = false;
    }
  }

  /**
   * Blocks or unblocks this person.
   *
   * The confirmation spells out what a block does and what it leaves alone, because the scope is
   * narrow and easy to over-read: the two accounts stop finding each other and neither can pull the
   * other into anything new, while existing conversations, groups and communities are untouched.
   */
  async function handleBlockToggle() {
    if (!profile?.id || blockLoading) return;
    actionMessage = '';

    if (!blocked) {
      const confirmed = await showConfirm(m.profile_block_confirm({ name: displayFallbackName }), {
        danger: true,
        confirmLabel: m.profile_block_btn(),
      });
      if (!confirmed) return;
    }

    blockLoading = true;
    try {
      if (blocked) {
        await unblockUser(profile.id);
        blocked = false;
        actionMessage = m.profile_unblock_done();
      } else {
        await blockUser(profile.id);
        blocked = true;
        // The server severs both follows as part of blocking; reflect it rather than re-fetching.
        followStatus = null;
        actionMessage = m.profile_block_done();
      }
    } catch (err) {
      Log.d('profile.handleBlockToggle failed', err);
      error = m.common_generic_error_label();
    } finally {
      blockLoading = false;
    }
  }

  /** Files a report against this person. Separate from blocking: one is private, the other is not. */
  async function submitUserReport(reason: ReportReason) {
    if (!profile?.id) return;
    reportSubmitting = true;
    actionMessage = '';
    try {
      await createReport('user', profile.id, reason, undefined, profile.id);
      actionMessage = m.post_signalement_merci();
    } catch (err) {
      if (err instanceof ModerationApiError && err.isAlreadyReported) {
        actionMessage = m.profile_already_reported();
      } else {
        Log.d('profile.submitUserReport failed', err);
        error = m.post_unable_to_report();
      }
    } finally {
      reportSubmitting = false;
      reportOpen = false;
    }
  }
</script>

<!--
  NO `PageHeader` HERE, AND THAT IS NOT AN OMISSION. A profile's title is the person, drawn inside
  the identity card with their avatar - putting their name a second time above it would say it
  twice. What this page owes the rest of the app is the COLUMN, which is what it now takes.
-->
<PageContainer>
  <div class="space-y-6 md:space-y-8">
    {#if loading}
      <div class="text-text-muted flex flex-col items-center justify-center gap-4 py-32" in:fade>
        <LoaderCircle size={32} class="text-accent-icon animate-spin" strokeWidth={2.5} />
        <span class="text-sm font-bold">{m.profile_public_loading()}</span>
      </div>
    {:else if error}
      <div
        class="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-red-600 shadow-sm dark:text-red-400"
        in:slide
      >
        <CircleAlert size={20} class="mt-0.5 shrink-0" />
        <div>
          <h3 class="mb-1 text-sm font-bold">{m.common_error_heading()}</h3>
          <p class="text-sm font-medium">{error}</p>
        </div>
      </div>
    {:else if profile}
      <!--
        Public profile header: `ProfileHeader` is the layout of this page and of `/profile` both
        (someone else's profile and your own are the same screen with different actions). Report and
        block are two separate gestures, deliberately - a block is private and stays between the two
        people, a report asks a moderator to look - so they stay two entries of the "..." menu and
        never one control: one control would have made every block a moderation event.
      -->
      {@const p = profile}
      <ProfileHeader userId={p.id} name={displayFallbackName}>
        {#snippet details()}
          <ProfileSummaryLine userId={p.id} profile={p} />
          <ProfileMinesweeperBadge userId={p.id} />
        {/snippet}
        {#snippet actions()}
          <!-- ONE accent button: "Suivre" until the reader follows, then "Message". -->
          <Button
            variant={followStatus ? 'secondary' : 'primary'}
            class="min-h-11 flex-1 sm:flex-none"
            onclick={handleFollowToggle}
            disabled={followLoading || fromCopy}
            data-follow-status={followStatus ?? 'none'}
          >
            {#if followStatus === 'accepted'}
              <UserCheck size={16} class="shrink-0" />
            {:else if followStatus === 'pending'}
              <UserRoundCheck size={16} class="shrink-0" />
            {:else}
              <UserPlus size={16} class="shrink-0" />
            {/if}
            <span class="whitespace-nowrap">{followLabel(followStatus)}</span>
          </Button>
          <Button
            variant={followStatus ? 'primary' : 'secondary'}
            class="min-h-11 flex-1 sm:flex-none"
            onclick={handleSendMessage}
          >
            <MessageCircle size={16} class="shrink-0" />
            <span class="whitespace-nowrap">{m.profile_public_message_btn()}</span>
          </Button>
          <!--
            THE BELL (engagement WP-3, L7): offered once the reader FOLLOWS this person (accepted) -
            a bell on someone whose posts the reader is not told of would be a second, silent follow.
            A glyph of the level, opening the level menu: a select would not fit the row.
          -->
          {#if followStatus === 'accepted'}
            <AccountBell kind="user" targetId={p.id} iconOnly />
          {/if}
          <ProfileOverflowMenu
            {blocked}
            busy={blockLoading || fromCopy}
            onReport={() => (reportOpen = true)}
            onBlockToggle={handleBlockToggle}
          />
        {/snippet}
      </ProfileHeader>

      {#if actionMessage}
        <p class="text-text-muted text-xs font-medium" role="status">{actionMessage}</p>
      {/if}

      {#if blocked}
        <p
          class="text-text-muted rounded-xl border border-black/5 bg-black/[0.03] px-4 py-3 text-xs dark:border-white/10 dark:bg-white/[0.03]"
        >
          {m.profile_blocked_notice()}
        </p>
      {/if}

      <!--
        "SUIVEZ AUSSI..." (engagement WP-6, L15): right after a follow or a request made here, the
        READER's own suggestions minus this person - never this person's follows.
      -->
      {#if followedHereId === profile.id && followStatus}
        <FollowAlsoSuggestions exclude={profile.id} />
      {/if}

      <!-- Bio section -->
      {#if profile.bio}
        <div
          class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-75 duration-500 md:p-8"
          style="animation-fill-mode: backwards;"
        >
          <h2 class="text-text-main mb-4 text-lg font-bold">
            {m.profile_public_about_heading()}
          </h2>
          <ProfileBioMarkdown source={profile.bio} />
        </div>
      {/if}

      {#if memberships.length > 0 || extrasLoading}
        <div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-6 shadow-sm md:p-8">
          <h2 class="text-text-main mb-5 flex items-center gap-2 text-lg font-bold">
            <Building2 size={20} />
            {m.assoc_list_heading()}
          </h2>
          <ProfileAssociationsSection {memberships} loading={extrasLoading} />
        </div>
      {/if}

      {#if roleHistory.length > 0 || extrasLoading}
        <div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-6 shadow-sm md:p-8">
          <h2 class="text-text-main mb-5 text-lg font-bold">
            {m.profile_public_career_heading()}
          </h2>
          <ProfileRoleHistorySection entries={roleHistory} />
        </div>
      {/if}

      {#if (parrainage?.parrains.length ?? 0) > 0 || (parrainage?.fillots.length ?? 0) > 0 || extrasLoading}
        <div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-6 shadow-sm md:p-8">
          <h2 class="text-text-main mb-5 flex items-center gap-2 text-lg font-bold">
            <Users size={20} />
            {m.profile_public_sponsorship_heading()}
          </h2>
          <ProfileParrainageSection
            parrains={parrainage?.parrains ?? []}
            fillots={parrainage?.fillots ?? []}
            loading={extrasLoading}
          />
        </div>
      {/if}

      <!-- Information section -->
      <div
        class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-150 duration-500 md:p-8"
        style="animation-fill-mode: backwards;"
      >
        <h2 class="text-text-main mb-6 text-lg font-bold">{m.profile_public_info_heading()}</h2>

        <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div
            class="bg-cn-surface flex items-center gap-3.5 rounded-2xl border border-black/5 p-4 shadow-sm dark:border-white/5"
          >
            <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
              <GraduationCap size={20} strokeWidth={2.5} />
            </div>
            <div class="min-w-0">
              <p class="text-text-muted text-2xs mb-0.5 font-bold">
                {m.profile_promo_label()}
              </p>
              <p class="text-text-main truncate text-sm font-bold">
                {profile.cursus?.length
                  ? profile.cursus.map((e) => formatYear(e.promo)).join(' · ')
                  : formatYear(null)}
              </p>
            </div>
          </div>

          <div
            class="bg-cn-surface flex items-center gap-3.5 rounded-2xl border border-black/5 p-4 shadow-sm dark:border-white/5"
          >
            <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
              <CalendarDays size={20} strokeWidth={2.5} />
            </div>
            <div class="min-w-0">
              <p class="text-text-muted text-2xs mb-0.5 font-bold">
                {m.profile_member_since_label()}
              </p>
              <p class="text-text-main text-sm font-bold capitalize">
                {new Date(profile.createdAt).toLocaleDateString(intlLocale(), {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
</PageContainer>

<ReportReasonDialog
  open={reportOpen}
  title={m.report_user_dialog_title()}
  targetPreview={displayFallbackName}
  submitting={reportSubmitting}
  onSubmit={submitUserReport}
  onClose={() => (reportOpen = false)}
/>
