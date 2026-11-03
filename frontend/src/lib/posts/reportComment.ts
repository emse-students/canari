import { createReport, ModerationApiError } from '$lib/moderation/api';
import type { ReportReason } from '$lib/moderation/reasons';
import type { PostComment, PostEntity } from '$lib/posts/api';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';

/**
 * How a post or comment report ended, in the reader's words: `ok` is a report filed, one already
 * on file, or content no longer available (all said as information), otherwise a real failure,
 * said as one. Either way the reason dialog closes: nothing here is worth a retry but the failure,
 * and the reader opens the dialog again for that.
 */
export interface CommentReportOutcome {
  ok: boolean;
  message: string;
}

/**
 * The words for a report the server refused. The duplicate and the gone cases are read off the
 * server's `code`, never off its wording ({@link ModerationApiError}); anything else is SHOWN as a
 * failure, so a moderation outage never looks like a successful report.
 */
function refusalOutcome(err: unknown, what: string, alreadyMessage: string): CommentReportOutcome {
  if (err instanceof ModerationApiError && err.isAlreadyReported) {
    return { ok: true, message: alreadyMessage };
  }
  if (err instanceof ModerationApiError && err.isContentNotFound) {
    // No longer one this reader may open (`404 CONTENT_NOT_FOUND`): said, never retried.
    Log.d('report', `${what} is gone (404 CONTENT_NOT_FOUND)`);
    return { ok: true, message: m.post_report_content_gone() };
  }
  Log.d(`report failed: ${what}`, err);
  return { ok: false, message: m.post_unable_to_report() };
}

/**
 * Files a report on `comment` - ONE path for every surface showing a post's comments (the card and
 * the CanaReels comments sheet).
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
    return refusalOutcome(
      err,
      `comment ${comment.id.slice(0, 8)}`,
      m.post_comment_already_reported()
    );
  }
}

/** Files a report on `post` - the card's report path, worded as {@link reportComment}'s. */
export async function reportPost(
  post: Pick<PostEntity, 'id' | 'authorId'>,
  reason: ReportReason
): Promise<CommentReportOutcome> {
  Log.d('reportPost', `post ${post.id.slice(0, 8)} reason=${reason}`);
  try {
    await createReport('post', post.id, reason, undefined, post.authorId ?? null);
    return { ok: true, message: m.post_signalement_merci() };
  } catch (err) {
    return refusalOutcome(err, `post ${post.id.slice(0, 8)}`, m.post_already_reported());
  }
}
