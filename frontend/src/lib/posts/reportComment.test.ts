/**
 * How a post or comment report is worded - every outcome read off the server's `code`, never its
 * prose: filed, already filed (`409 ALREADY_REPORTED`), gone (`404 CONTENT_NOT_FOUND`: the reporter
 * may no longer open it, and the server says why to nobody), or a failure SHOWN as one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModerationApiError } from '$lib/moderation/api';
import { reportComment, reportPost } from './reportComment';
import type { PostComment } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';

const h = vi.hoisted(() => ({ createReport: vi.fn() }));

vi.mock('$lib/moderation/api', async (orig) => ({
  ...(await orig<typeof import('$lib/moderation/api')>()),
  createReport: h.createReport,
}));

const COMMENT = { id: 'c1234567-0000', userId: 'writer' } as PostComment;
const POST = { id: 'p1234567-0000', authorId: 'author' };

const refusal = (status: number, code: string | null) =>
  new ModerationApiError(status, code, `moderation ${status}`);

beforeEach(() => h.createReport.mockReset());

describe('ModerationApiError.isContentNotFound', () => {
  it('is the 404 CONTENT_NOT_FOUND code and nothing else', () => {
    expect(refusal(404, 'CONTENT_NOT_FOUND').isContentNotFound).toBe(true);
    expect(refusal(404, 'LIVE_NOT_FOUND').isContentNotFound).toBe(false);
    expect(refusal(404, null).isContentNotFound).toBe(false);
  });
});

describe.each([
  [
    'comment',
    () => reportComment(COMMENT, 'spam'),
    m.post_comment_reported,
    m.post_comment_already_reported,
  ],
  ['post', () => reportPost(POST, 'spam'), m.post_signalement_merci, m.post_already_reported],
] as const)('a %s report', (kind, report, filed, already) => {
  it('filed: thanks', async () => {
    h.createReport.mockResolvedValue({});
    await expect(report()).resolves.toEqual({ ok: true, message: filed() });
    expect(h.createReport).toHaveBeenCalledWith(
      kind,
      kind === 'post' ? POST.id : COMMENT.id,
      'spam',
      undefined,
      kind === 'post' ? 'author' : 'writer'
    );
  });

  it('409 ALREADY_REPORTED: already on file, said as information', async () => {
    h.createReport.mockRejectedValueOnce(refusal(409, 'ALREADY_REPORTED'));
    await expect(report()).resolves.toEqual({ ok: true, message: already() });
  });

  it('404 CONTENT_NOT_FOUND: "no longer available", said as information', async () => {
    h.createReport.mockRejectedValueOnce(refusal(404, 'CONTENT_NOT_FOUND'));
    await expect(report()).resolves.toEqual({ ok: true, message: m.post_report_content_gone() });
  });

  it('a 404 without the code, or any other failure, is a failure shown as one', async () => {
    for (const err of [refusal(404, null), refusal(503, null), new Error('offline')]) {
      h.createReport.mockRejectedValueOnce(err);
      await expect(report()).resolves.toEqual({ ok: false, message: m.post_unable_to_report() });
    }
  });
});
