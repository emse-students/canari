<script lang="ts">
  /**
   * THE VIEWER'S REPORT CONTROL (WP-L8, client half; Apple guideline 1.2 and the Play UGC policy ask
   * for a way to report objectionable content AND to block its author, from the content itself).
   *
   * A flag button in the viewer's TOP BAR - the strip above the picture, so it never covers the
   * video, a double-tap region or the chat panel - opening the posts' own `ReportReasonDialog`
   * (one reason list, `contentType: 'live'`, `contentId` = the live's id; the server reads the
   * broadcaster from the live row, never from the client). Every outcome is a typed answer, never
   * a message read: `409 ALREADY_REPORTED` (thanks, already done), `404 LIVE_NOT_FOUND` (the live is
   * gone) and anything else (try again). After a report that was FILED, the person is offered to
   * block the broadcaster, with a confirmation; a block closes the live, since its author is
   * someone the viewer asked never to see again.
   *
   * The broadcaster's own copy of the viewer shows nothing: nobody reports themselves.
   *
   * A single chat line cannot be reported: `content_reports` takes `live`, not a message, by the
   * privacy decision in docs/wiki/services/lives.md - a viewer reports the live or the person.
   */
  import { Flag } from '@lucide/svelte';
  import ReportReasonDialog from '$lib/components/moderation/ReportReasonDialog.svelte';
  import { createReport, ModerationApiError } from '$lib/moderation/api';
  import type { ReportReason } from '$lib/moderation/reasons';
  import { blockUser } from '$lib/users/blocks';
  import { getSavedUserId } from '$lib/stores/user';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import type { LiveListItem } from '$lib/live/types';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    live: LiveListItem;
    /** The broadcaster was blocked: the viewer leaves the live. */
    onBlocked: () => void;
  }

  let { live, onBlocked }: Props = $props();

  let open = $state(false);
  let submitting = $state(false);

  const ownLive = $derived(getSavedUserId() === live.broadcasterId);

  async function submit(reason: ReportReason) {
    submitting = true;
    console.debug(`[LIVE] report: filing ${reason} on ${live.id}`);
    let filed = false;
    try {
      await createReport('live', live.id, reason);
      filed = true;
      console.debug(`[LIVE] report: filed on ${live.id}`);
      showToast(m.live_report_done(), 'info');
    } catch (err) {
      if (err instanceof ModerationApiError && err.isAlreadyReported) {
        console.debug(`[LIVE] report: ${live.id} was already reported`);
        showToast(m.live_report_already(), 'info');
      } else if (err instanceof ModerationApiError && err.isLiveNotFound) {
        console.warn(`[LIVE] report: ${live.id} is gone (404 LIVE_NOT_FOUND)`);
        showToast(m.live_report_gone(), 'info');
      } else {
        console.error(`[LIVE] report: ${live.id} failed`, err);
        showToast(m.live_report_failed(), 'error');
        // The dialog stays open: the person can send it again.
        submitting = false;
        return;
      }
    }
    submitting = false;
    open = false;
    if (filed) await offerBlock();
  }

  async function offerBlock() {
    const yes = await showConfirm(m.live_report_block_prompt(), {
      danger: true,
      confirmLabel: m.live_report_block_confirm(),
    });
    console.debug(`[LIVE] report: block offer on ${live.broadcasterId} answered ${yes}`);
    if (!yes) return;
    try {
      await blockUser(live.broadcasterId);
      showToast(m.live_report_block_done(), 'info');
    } catch (err) {
      console.error(`[LIVE] report: blocking ${live.broadcasterId} failed`, err);
      showToast(m.live_report_block_failed(), 'error');
      return;
    }
    onBlocked();
  }
</script>

{#if !ownLive}
  <button
    type="button"
    class="ui-icon-button rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500"
    aria-label={m.live_report_button()}
    title={m.live_report_button()}
    aria-haspopup="dialog"
    onclick={() => {
      console.debug(`[LIVE] report: dialog opened on ${live.id}`);
      open = true;
    }}
    data-live-report
  >
    <Flag size={22} aria-hidden="true" />
  </button>

  <ReportReasonDialog
    {open}
    layer="critical"
    title={m.live_report_dialog_title()}
    {submitting}
    onSubmit={submit}
    onClose={() => (open = false)}
  />
{/if}
