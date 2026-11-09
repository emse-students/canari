<script lang="ts">
  import { Check, Flag, PencilLine, RotateCcw, X } from '@lucide/svelte';
  import Modal from '../shared/Modal.svelte';
  import Avatar from '../shared/Avatar.svelte';
  import UserName from '../shared/UserName.svelte';
  import EmojiText from '../shared/EmojiText.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import ReportReasonDialog from '$lib/components/moderation/ReportReasonDialog.svelte';
  import { m } from '$lib/paraglide/messages';
  import { createReport, ModerationApiError } from '$lib/moderation/api';
  import type { ReportReason } from '$lib/moderation/reasons';
  import { refusalCode } from '$lib/utils/apiRefusal';
  import {
    communityNicknameScope,
    nicknameEntry,
    nicknameHiddenByBlock,
    visibleNickname,
  } from '$lib/utils/users/conversationNicknames.svelte';
  import { userDisplayNames } from '$lib/utils/users/displayNames.svelte';
  import { NICKNAME_MAX_LENGTH } from '$lib/utils/users/nicknameRules';
  import { mayNameMember } from '$lib/utils/chat/nicknamePermission';
  import {
    loadCommunityNicknames,
    saveNickname,
    type NicknameOutcome,
    type NicknamePlace,
  } from '$lib/utils/chat/nicknameActions';

  /**
   * "MODIFIER LES PSEUDOS" (owner, 2026-10-14): the Messenger screen - every member, the name the
   * conversation shows for them, and a pencil to change it. A DM, a group and a community share it;
   * WHERE the change goes and WHO may make it come from `place` (`nicknameActions`,
   * `nicknamePermission`), never from this screen.
   */
  interface Props {
    /** Whether the modal is shown. */
    open: boolean;
    /** The members listed, the viewer included. */
    members: string[];
    /** The signed-in account. */
    viewerId: string;
    /** Where a change is written: an MLS room or a community. */
    place: NicknamePlace;
    onClose: () => void;
  }

  let { open, members, viewerId, place, onClose }: Props = $props();

  const scope = $derived(
    place.kind === 'group' ? place.scope : communityNicknameScope(place.workspaceId)
  );
  const standing = $derived(
    place.kind === 'community'
      ? { inCommunity: true, canModerate: place.canModerate }
      : { inCommunity: false, canModerate: false }
  );
  const viewer = $derived(viewerId.trim().toLowerCase());

  /** The member shown with their nickname's metadata, read from the register (reactive). */
  const rows = $derived(
    members.map((id) => {
      const userId = id.trim().toLowerCase();
      const shown = visibleNickname(scope, userId);
      // The RAW entry decides the reset: a nickname the viewer is not shown (set by someone they
      // stand in a block with, or not checked yet) is still there for everyone else, and the reset
      // is the remedy - hiding it with the name would take the remedy away (review of #3177).
      const raw = nicknameEntry(scope, userId);
      const isSelf = userId === viewer;
      const held = raw?.nickname != null;
      return {
        userId,
        isSelf,
        nickname: shown,
        // Only once the block answer is KNOWN: while it is pending the row shows the plain name.
        hiddenFromViewer: held && shown === null && nicknameHiddenByBlock(scope, userId),
        setBy: shown === null ? null : (raw?.setBy ?? null),
        reportSubject: shown === null ? null : (raw?.reportSubject ?? null),
        canEdit: mayNameMember(standing, { isSelf, isReset: false }),
        canReset: held && mayNameMember(standing, { isSelf, isReset: true }),
      };
    })
  );
  // The setters are named by their PROFILE: "défini par" answers who did it, not what they are called
  // here - and it must survive the setter's own nickname being the insult.
  const setterNames = userDisplayNames(() => rows.flatMap((r) => (r.setBy ? [r.setBy] : [])));
  const memberNames = userDisplayNames(() => rows.map((r) => r.userId));

  let editing = $state<string | null>(null);
  let draft = $state('');
  let saving = $state(false);
  let error = $state('');
  let notice = $state('');
  let listUnreadable = $state(false);

  // A COMMUNITY'S REGISTER IS READ AT EACH OPENING: the live event only reaches a device that was
  // connected, and this read is what makes the screen right for one that was not. Once per opening,
  // so a failure is said once and never retried in a loop.
  let readFor = '';
  $effect(() => {
    if (!open) {
      readFor = '';
      editing = null;
      error = '';
      notice = '';
      return;
    }
    if (place.kind !== 'community' || readFor === place.workspaceId) return;
    const workspaceId = place.workspaceId;
    readFor = workspaceId;
    void loadCommunityNicknames(workspaceId).then((ok) => {
      if (readFor === workspaceId) listUnreadable = !ok;
    });
  });

  function startEdit(userId: string, current: string | null) {
    editing = userId;
    draft = current ?? '';
    error = '';
    notice = '';
  }

  /** The sentence each refusal is shown as - one per outcome, none read out of a message. */
  function outcomeText(outcome: NicknameOutcome): string {
    switch (outcome) {
      case 'too_long':
        return m.chat_nicknames_error_too_long({ max: NICKNAME_MAX_LENGTH });
      case 'not_allowed':
        return m.chat_nicknames_error_not_allowed();
      case 'blocked':
        return m.chat_nicknames_error_blocked();
      case 'not_member':
        return m.chat_nicknames_error_not_member();
      case 'not_queued':
        return m.chat_nicknames_error_not_queued();
      case 'saved':
        return '';
      case 'failed':
        return m.chat_nicknames_error_failed();
    }
  }

  async function submit(userId: string, value: string) {
    if (saving) return;
    saving = true;
    error = '';
    notice = '';
    try {
      const outcome = await saveNickname(place, viewer, userId, value);
      if (outcome === 'saved') editing = null;
      else error = outcomeText(outcome);
    } finally {
      saving = false;
    }
  }

  function handleKey(e: KeyboardEvent, userId: string) {
    if (e.key === 'Enter') void submit(userId, draft);
    if (e.key === 'Escape') editing = null;
  }

  // ── Reporting a community nickname ───────────────────────────────────────────
  let reporting = $state<{ subject: string; text: string } | null>(null);
  let reportSubmitting = $state(false);

  async function submitReport(reason: ReportReason) {
    if (!reporting) return;
    reportSubmitting = true;
    error = '';
    notice = '';
    try {
      await createReport('nickname', reporting.subject, reason);
      notice = m.post_signalement_merci();
    } catch (err) {
      if (err instanceof ModerationApiError && err.isAlreadyReported) {
        notice = m.chat_nicknames_already_reported();
      } else if (refusalCode(err) === 'CONTENT_NOT_FOUND') {
        notice = m.chat_nicknames_report_gone();
      } else {
        console.warn(`[NICKNAME] report refused: ${String(err)}`);
        error = m.post_unable_to_report();
      }
    } finally {
      reportSubmitting = false;
      reporting = null;
    }
  }
</script>

<Modal {open} {onClose} title={m.chat_nicknames_title()} maxWidth="max-w-md">
  <div class="flex flex-col gap-4 px-1 pb-2">
    <p class="text-text-muted text-sm leading-relaxed">
      {place.kind === 'community'
        ? m.chat_nicknames_description_community()
        : m.chat_nicknames_description_group()}
    </p>
    {#if listUnreadable}
      <p class="text-xs font-medium text-amber-600 dark:text-amber-400">
        {m.chat_nicknames_list_unreadable()}
      </p>
    {/if}

    <ul
      class="bg-cn-surface flex max-h-[55dvh] flex-col overflow-y-auto rounded-2xl border border-black/5 dark:border-white/10"
    >
      {#each rows as row, index (row.userId)}
        <li
          data-nickname-row={row.userId}
          class="flex flex-col gap-2 px-4 py-3 {index !== rows.length - 1
            ? 'border-b border-black/5 dark:border-white/5'
            : ''}"
        >
          <div class="flex items-center gap-3">
            <Avatar userId={row.userId} size="sm" />
            <div class="min-w-0 flex-1">
              {#if row.nickname !== null}
                <div class="text-text-main truncate text-sm font-semibold">
                  <EmojiText text={row.nickname} />
                </div>
                <div class="text-text-muted truncate text-xs">
                  <UserName userId={row.userId} link={false} />
                  {#if row.setBy}
                    · {m.chat_nicknames_set_by({
                      name: setterNames.get(row.setBy) ?? row.setBy.slice(0, 8),
                    })}
                  {/if}
                </div>
              {:else}
                <UserName
                  userId={row.userId}
                  link={false}
                  class="text-text-main truncate text-sm font-semibold"
                />
                {#if row.hiddenFromViewer}
                  <div data-nickname-hidden class="text-text-muted text-xs">
                    {m.chat_nicknames_hidden_for_you()}
                  </div>
                {:else if row.canEdit}
                  <div class="text-text-muted text-xs">{m.chat_nicknames_set_placeholder()}</div>
                {/if}
              {/if}
            </div>
            {#if row.canReset && editing !== row.userId}
              <Button
                variant="ghost"
                size="compact"
                icon
                data-nickname-reset={row.userId}
                onclick={() => void submit(row.userId, '')}
                disabled={saving}
                aria-label={m.chat_nicknames_reset_button()}
                title={m.chat_nicknames_reset_button()}
              >
                <RotateCcw size={16} />
              </Button>
            {/if}
            {#if place.kind === 'community' && row.reportSubject && row.setBy && row.setBy !== viewer}
              <Button
                variant="ghost"
                size="compact"
                icon
                data-nickname-report={row.userId}
                onclick={() =>
                  (reporting = { subject: row.reportSubject!, text: row.nickname ?? '' })}
                aria-label={m.chat_nicknames_report_button()}
                title={m.chat_nicknames_report_button()}
              >
                <Flag size={16} />
              </Button>
            {/if}
            {#if row.canEdit && editing !== row.userId}
              <Button
                variant="ghost"
                size="compact"
                icon
                data-nickname-edit={row.userId}
                onclick={() => startEdit(row.userId, row.nickname)}
                aria-label={m.chat_nicknames_edit_label({
                  member: memberNames.get(row.userId) ?? row.userId.slice(0, 8),
                })}
              >
                <PencilLine size={16} />
              </Button>
            {/if}
          </div>
          {#if editing === row.userId}
            <div class="flex items-center gap-2">
              <Input
                class="min-w-0 flex-1"
                density="compact"
                data-nickname-input={row.userId}
                bind:value={draft}
                onkeydown={(e) => handleKey(e, row.userId)}
                placeholder={m.chat_nicknames_set_placeholder()}
                aria-label={m.chat_nicknames_edit_label({
                  member: memberNames.get(row.userId) ?? row.userId.slice(0, 8),
                })}
                autofocus
                disabled={saving}
              />
              <Button
                size="compact"
                icon
                onclick={() => void submit(row.userId, draft)}
                disabled={saving}
                aria-label={m.common_validate_button()}
              >
                <Check size={16} strokeWidth={3} />
              </Button>
              <Button
                variant="secondary"
                size="compact"
                icon
                onclick={() => (editing = null)}
                disabled={saving}
                aria-label={m.common_cancel_button()}
              >
                <X size={16} strokeWidth={3} />
              </Button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    {#if error}
      <p role="alert" class="text-xs font-medium text-red-600 dark:text-red-400">{error}</p>
    {/if}
    {#if notice}
      <p class="text-text-muted text-xs font-medium">{notice}</p>
    {/if}
  </div>
</Modal>

<ReportReasonDialog
  open={reporting !== null}
  title={m.chat_nicknames_report_title()}
  targetPreview={reporting?.text ?? ''}
  submitting={reportSubmitting}
  layer="critical"
  onSubmit={(reason) => void submitReport(reason)}
  onClose={() => (reporting = null)}
/>
