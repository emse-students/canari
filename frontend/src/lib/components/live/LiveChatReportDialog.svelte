<script lang="ts">
  /**
   * REPORTING ONE LINE OF A LIVE CHAT (WP-L8b, client half), the posts' flow: the same
   * `ReportReasonDialog` (one reason list), raised on the `critical` layer because the viewer sits
   * above a plain modal. The line's author is read by the SERVER from its own row; the client hands
   * over the plaintext it sees, the one thing a moderator cannot otherwise read (the live key goes
   * with the live). Outcomes are typed, never read from a message: `409 ALREADY_REPORTED`,
   * `404 LIVE_NOT_FOUND`, anything else keeps the dialog open to try again.
   *
   * Built against the CONTRACT in docs/wiki/services/lives.md ("A reported chat line is kept until
   * handled"); the server route is another pull request's, so until it lands a report answers an
   * error and the dialog stays open. Lives are dev builds only.
   */
  import ReportReasonDialog from '$lib/components/moderation/ReportReasonDialog.svelte';
  import { createLiveChatReport, ModerationApiError } from '$lib/moderation/api';
  import type { ReportReason } from '$lib/moderation/reasons';
  import type { LiveChatLine } from '$lib/live/liveChat';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    liveId: string;
    /** The line being reported, or null when the dialog is closed. Only a line the server numbered. */
    line: LiveChatLine | null;
    onClose: () => void;
  }

  let { liveId, line, onClose }: Props = $props();

  let submitting = $state(false);

  async function submit(reason: ReportReason) {
    if (!line || line.id === null) return;
    submitting = true;
    console.debug(`[LIVE] chat report: filing ${reason} on message ${line.id} of ${liveId}`);
    try {
      await createLiveChatReport({
        liveId,
        messageId: line.id,
        reason,
        message: line.text,
      });
      console.debug(`[LIVE] chat report: filed on message ${line.id}`);
      showToast(m.live_chat_report_done(), 'info');
    } catch (err) {
      if (err instanceof ModerationApiError && err.isAlreadyReported) {
        console.debug(`[LIVE] chat report: message ${line.id} was already reported`);
        showToast(m.live_chat_report_already(), 'info');
      } else if (err instanceof ModerationApiError && err.isLiveNotFound) {
        console.warn(`[LIVE] chat report: ${liveId} is gone (404 LIVE_NOT_FOUND)`);
        showToast(m.live_chat_report_gone(), 'info');
      } else {
        console.error(`[LIVE] chat report: message ${line.id} failed`, err);
        showToast(m.live_chat_report_failed(), 'error');
        // The dialog stays open: the person can send it again.
        submitting = false;
        return;
      }
    }
    submitting = false;
    onClose();
  }
</script>

<ReportReasonDialog
  open={line !== null}
  layer="critical"
  title={m.live_chat_report_dialog_title()}
  targetPreview={line?.text ?? ''}
  {submitting}
  onSubmit={submit}
  {onClose}
/>
