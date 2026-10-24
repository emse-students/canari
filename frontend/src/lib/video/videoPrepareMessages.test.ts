/**
 * Every fault has a sentence except the cancel, which shows nothing - and the progress line never
 * reads past 100 or below 0, whatever fraction an encoder reports.
 */
import { m } from '$lib/paraglide/messages';
import { VideoPrepareError, type VideoPrepareFault } from './prepareVideoForUpload';
import {
  isUnpreparableFault,
  videoPrepareFailureMessage,
  videoPrepareProgressLabel,
} from './videoPrepareMessages';

describe('videoPrepareFailureMessage', () => {
  it.each<[VideoPrepareFault, string | null]>([
    ['aborted', null],
    ['unreadable', m.video_prepare_unreadable()],
    ['no-video-track', m.video_prepare_unreadable()],
    ['too-long', m.video_prepare_too_long()],
    ['too-large', m.video_prepare_too_long()],
    ['unsupported', m.video_prepare_unsupported()],
    ['encode', m.video_prepare_failed()],
  ])('%s', (fault, sentence) => {
    expect(videoPrepareFailureMessage(new VideoPrepareError(fault, 'dev prose'))).toBe(sentence);
  });
});

describe('isUnpreparableFault (a queued chat reel fails for good, RC-5)', () => {
  it.each<[VideoPrepareFault, boolean]>([
    ['unreadable', true],
    ['no-video-track', true],
    ['too-long', true],
    ['too-large', true],
    ['unsupported', true],
    // The encoder failing while working may succeed later; a cancel is not a refusal.
    ['encode', false],
    ['aborted', false],
  ])('%s -> %s', (fault, forGood) => {
    expect(isUnpreparableFault(fault)).toBe(forGood);
  });
});

describe('videoPrepareProgressLabel', () => {
  it('rounds to a whole percentage and clamps', () => {
    expect(videoPrepareProgressLabel(0.424)).toBe(m.video_prepare_progress({ percent: 42 }));
    expect(videoPrepareProgressLabel(1.2)).toBe(m.video_prepare_progress({ percent: 100 }));
    expect(videoPrepareProgressLabel(-1)).toBe(m.video_prepare_progress({ percent: 0 }));
  });
});
