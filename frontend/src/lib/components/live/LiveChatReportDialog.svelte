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
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  const TAG = 'LIVE_CHAT_REPORT';

  interface Props {
    liveId: string;
    /** The line being reported, or null when the dialog is closed. Only a line the server numbered. */
    line: LiveChatLine | null;
    onClose: () => void;
  }

  let { liveId, line, onClose }: Props = $props();

  let submitting = $state(false);

  /**
   * What each typed refusal does: the sentence, and whether the dialog closes. A refusal the person
   * can read and act on keeps the dialog open; one that settles the question closes it.
   */
  function outcomeOf(err: unknown): { text: string; close: boolean } {
    if (err instanceof ModerationApiError) {
      // Uniform on the server (a hidden line, a block, an invisible live, an unknown message).
      if (err.isAlreadyReported) return { text: m.live_chat_report_already(), close: true };
      if (err.isLiveNotFound) return { text: m.live_chat_report_gone(), close: true };
      if (err.isLiveChatReportMismatch)
        return { text: m.live_chat_report_mismatch(), close: false };
      // Over the server's 900 UTF-8 bytes. The client sets no bound of its own: a line another
      // client sent can exceed the composer's 300 characters and is still reportable.
      if (err.isLiveChatReportInvalid) return { text: m.live_chat_report_too_long(), close: false };
      // 503: the server cannot sign, so the evidence cannot be kept and nothing is filed.
      if (err.isLiveReportSigningUnavailable) {
        return { text: m.live_chat_report_unavailable(), close: false };
      }
    }
    return { text: m.live_chat_report_failed(), close: false };
  }

  async function submit(reason: ReportReason) {
    if (!line || line.id === null) return;
    submitting = true;
    Log.i(TAG, `filing ${reason} on message ${line.id} of ${liveId}`);
    try {
      await createLiveChatReport({ liveId, messageId: line.id, reason, message: line.text });
      Log.i(TAG, `filed on message ${line.id}`);
      showToast(m.live_chat_report_done(), 'info');
      onClose();
    } catch (err) {
      const { text, close } = outcomeOf(err);
      const code = err instanceof ModerationApiError ? (err.code ?? err.status) : String(err);
      Log.i(TAG, `message ${line.id} refused (${code}), dialog ${close ? 'closes' : 'stays open'}`);
      showToast(text, close ? 'info' : 'error');
      if (close) onClose();
    } finally {
      submitting = false;
    }
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
