/**
 * THE MAPPING IS THE FIX, SO THE MAPPING IS WHAT IS PINNED.
 *
 * A member reported on 2026-09-21 that a post would not publish, and the only thing the app had
 * told them was "could not publish the post". Seven causes wore that sentence, five of which had
 * already been written in the reader's language at the throw. Nothing on the server could add to
 * it: the request never left the device.
 *
 * What is asserted here is the half a screen cannot assert about itself - that each kind of
 * rejection comes out as the right sentence, including the two that are ABOUT THE READER and must
 * never be said when they are not true.
 */
import { describe, it, expect } from 'vitest';
import { publishFailureMessage } from './publishFailure';
import { MutedError } from '$lib/moderation/muteCheck';
import { LocalizedError } from '$lib/utils/localizedError';
import { ServerUnreachableError } from '$lib/utils/fetchOrUnreachable';
import { m } from '$lib/paraglide/messages';
import { VideoPrepareError } from '$lib/video/prepareVideoForUpload';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { MediaUploadError, overDailyLimitSentence } from '$lib/utils/mediaErrors';

const FALLBACK = m.post_create_publish_error();

describe('publishFailureMessage', () => {
  it("shows the throw's own sentence when the throw marked it as the reader's", () => {
    // The five the composer writes. One stands for all five: what is being pinned is that a
    // `LocalizedError` survives the catch, which is the whole of what was lost.
    const own = m.post_create_poll_requires_options();
    expect(publishFailureMessage(new LocalizedError(own), FALLBACK)).toBe(own);
  });

  it('says moderation refused, and does not show the moderator dev prose', () => {
    const shown = publishFailureMessage(new MutedError('spam'), FALLBACK);
    expect(shown).toBe(m.post_action_not_allowed());
    // The message on the type is English prose for a log, and the reason is a moderator's free
    // text - neither is a translated sentence, and neither may reach a screen by accident.
    expect(shown).not.toContain('moderation');
    expect(shown).not.toContain('spam');
  });

  it('tells a reader the server could not be REACHED, rather than accusing them', () => {
    // The one cause here a reader can act on, and the one that used to read as "you are
    // restricted" on `PostCard.handleReaction`.
    expect(
      publishFailureMessage(new TransportFailureError(new TypeError('Failed to fetch')), FALLBACK)
    ).toBe(m.auth_server_unreachable());
    // Read by TYPE, never by words: Tauri's typed failure is reached, a sentence that merely SAYS
    // network is not (`transportFailure.ts`).
    expect(
      publishFailureMessage(
        new TransportFailureError('error sending request for url (x)'),
        FALLBACK
      )
    ).toBe(m.auth_server_unreachable());
    expect(
      publishFailureMessage(new Error('NetworkError when attempting to fetch'), FALLBACK)
    ).not.toBe(m.auth_server_unreachable());
  });

  it('passes a ServerUnreachableError through with the sentence its caller chose', () => {
    // It is a `LocalizedError` subclass, so its own message wins - and it is reached by the
    // transport branch first only if the caller wrote none, which none do.
    const own = m.auth_pin_salt_unreachable();
    expect(publishFailureMessage(new ServerUnreachableError(own, null), FALLBACK)).toBe(own);
  });

  it('falls back for dev prose, which is most things and is why the fallback is required', () => {
    // A 500 from `createPost`, a compression failure, a browser string. English, for the console.
    expect(publishFailureMessage(new Error('Request failed with status 500'), FALLBACK)).toBe(
      FALLBACK
    );
    expect(publishFailureMessage('nope', FALLBACK)).toBe(FALLBACK);
    expect(publishFailureMessage(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it('lets each screen declare its own fallback, because three screens use this', () => {
    const err = new Error('Request failed with status 500');
    expect(publishFailureMessage(err, m.post_unable_to_comment())).toBe(m.post_unable_to_comment());
    expect(publishFailureMessage(err, m.post_action_not_allowed())).toBe(
      m.post_action_not_allowed()
    );
  });

  it('names why a video could not be prepared on the device', () => {
    expect(publishFailureMessage(new VideoPrepareError('too-long', 'x'), FALLBACK)).toBe(
      m.video_prepare_too_long()
    );
    expect(publishFailureMessage(new VideoPrepareError('unsupported', 'x'), FALLBACK)).toBe(
      m.video_prepare_unsupported()
    );
  });
});

describe('publishFailureMessage - the attachment cap', () => {
  it('words the typed POST_ATTACHMENTS_TOO_MANY refusal in the reader language, never the server prose', () => {
    const refusal = new ApiRefusalError(400, 'POST_ATTACHMENTS_TOO_MANY', 'A post has at most 10');
    expect(publishFailureMessage(refusal, FALLBACK)).toBe(m.post_attachments_too_many({ max: 10 }));
  });

  it('does not read the message: the same prose under another code is the fallback', () => {
    const other = new ApiRefusalError(400, 'SOMETHING_ELSE', 'A post has at most 10');
    expect(publishFailureMessage(other, FALLBACK)).toBe(FALLBACK);
  });
});

describe('publishFailureMessage - the reach of an institution post (owner, 2026-11-10)', () => {
  it.each([
    ['institution_reach_required', () => m.post_reach_required()],
    ['institution_reach_not_offered', () => m.post_reach_not_offered()],
    ['institution_reach_invalid', () => m.post_reach_invalid()],
    ['institution_reach_outside_audience', () => m.post_reach_outside_audience()],
  ])('words the typed %s refusal in the reader language', (code, sentence) => {
    const refusal = new ApiRefusalError(400, code, 'server prose');
    expect(publishFailureMessage(refusal, FALLBACK)).toBe(sentence());
  });
});

describe("publishFailureMessage - the member's daily upload bound", () => {
  it('words the typed refusal with the sentence the chat thread shows', () => {
    const refusal = new MediaUploadError(422, 'server prose', 'gateway', false, false, true);
    expect(publishFailureMessage(refusal, FALLBACK)).toBe(m.upload_over_daily_limit());
    expect(overDailyLimitSentence(refusal)).toBe(m.upload_over_daily_limit());
  });

  it('keeps the fallback for an upload refused for another reason', () => {
    expect(publishFailureMessage(new MediaUploadError(422, 'server prose'), FALLBACK)).toBe(
      FALLBACK
    );
    expect(overDailyLimitSentence(new MediaUploadError(413, 'x'))).toBeNull();
  });
});
