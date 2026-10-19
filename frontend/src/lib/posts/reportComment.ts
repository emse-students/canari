import { createReport, ModerationApiError } from '$lib/moderation/api';
import type { ReportReason } from '$lib/moderation/reasons';
import type { PostComment } from '$lib/posts/api';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';

/**
 * How a comment report ended, in the reader's words: `ok` is a report filed or one already on
 * file (both are said as information), otherwise a real failure, said as one.
 */
export interface CommentReportOutcome {
  ok: boolean;
  message: string;
}

/**
 * Files a report on `comment` - ONE path for every surface showing a post's comments (the card and
 * the CanaReels comments sheet). The duplicate case is read off the server's `code`, never off its
 * wording ({@link ModerationApiError}); anything else is SHOWN, so a moderation outage never looks
 * like a successful report.
 */
export async function reportComment(
  comment: PostComment,
  reason: ReportReason
): Promise<CommentReportOutcome> {
  Log.d('reportComment', `comment ${comment.id.slice(0, 8)} reason=${reason}`);
  try {
    await createReport('comment', comment.id, reason, undefined, comment.userId ?? null);
    return { ok: true, message: m.post_comment_reported() };
  } catch (err) {
    if (err instanceof ModerationApiError && err.isAlreadyReported) {
      return { ok: true, message: m.post_comment_already_reported() };
    }
    Log.d('reportComment failed', err);
    return { ok: false, message: m.post_unable_to_report() };
  }
}
