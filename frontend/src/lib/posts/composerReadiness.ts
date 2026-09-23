/**
 * WHAT THE COMPOSER ALREADY KNOWS BEFORE IT ASKS ANYBODY, AND WHY IT IS ONE FUNCTION.
 *
 * `publishPost` used to open with `await assertNotMuted()` - a round trip to
 * `GET /api/moderation/me/mute-status` - and only afterwards check three things it had held in its
 * own `$state` the whole time: that there is something to publish, that a poll carries a question
 * and two options, that a chosen form is actually chosen. **A member reported on 2026-09-21 that a
 * post would not publish, and the edge log of his 2026-09-23 retries is what named this**: two
 * `mute-status` calls, `200` both times, never followed by a `POST /api/posts` - two requests spent
 * to reach a refusal the client could have spoken instantly. He had opened a poll and not filled it.
 *
 * That is the rule this repository states for every other seam: **NEVER LEARN BY FAILING WHAT A
 * FACT COULD HAVE TOLD YOU.** Handing an operation to a layer in order to classify its refusal is
 * work the design owes, and here the discriminator was never anywhere else to begin with.
 *
 * THE SECOND REASON IT IS A MODULE IS THAT THE RULE HAD TWO COPIES AND THEY WERE ONE EDIT APART
 * FROM DISAGREEING. The Publier button spells `!markdown.trim() && selectedFiles.length === 0` to
 * decide whether it is enabled; the throw spelled the same thing to decide whether to refuse. Two
 * texts, one rule - and nothing would have failed if a later change had touched only one of them,
 * which is how a button becomes tappable for a post the next line rejects. {@link hasContent} is
 * now the only spelling, read by both.
 *
 * WHAT DOES NOT BELONG HERE is anything the composer cannot answer alone: moderation (the server
 * owns it), the upload token, the media pipeline, and the write itself. Those four keep their
 * stages in `publishPost` and their sentences in {@link publishFailureMessage}.
 */
import { m } from '$lib/paraglide/messages';
import type { PublishStage } from './publishFailure';

/** A poll option as `CreatePostPayload` wants it. */
export interface PollOption {
  label: string;
}

/** The composer state that can be judged without asking the network anything. */
export interface ComposerContents {
  /** The post body, already trimmed. */
  markdown: string;
  /** How many files are staged for upload. */
  fileCount: number;
  includePoll: boolean;
  pollQuestion: string;
  /** The options exactly as typed: one per line. */
  pollOptionsRaw: string;
  includeForm: boolean;
  selectedFormId: string;
}

/** Why this draft cannot be sent, said as the stage that refuses it and the reader's sentence. */
export interface PublishBlocker {
  /** The stage `publishPost` records, so the console line keeps naming WHERE. */
  stage: PublishStage;
  /** Already in the reader's language - it travels as a `LocalizedError`. */
  message: string;
}

/**
 * The poll options as typed, one per line, blanks dropped.
 *
 * Exported because the validator and the payload builder MUST NOT count differently: refusing on
 * "fewer than two" and then sending a third parsing of the same text is two implementations of one
 * rule, and the reader meets the disagreement as a post that vanishes.
 *
 * @param optionsRaw The textarea's contents, newline separated.
 * @returns One entry per non-blank line, trimmed, in the order typed.
 */
export function parsePollOptions(optionsRaw: string): PollOption[] {
  return optionsRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label) => ({ label }));
}

/**
 * Whether there is anything to publish at all - the ONE spelling of the Publier button's rule.
 *
 * @param markdown The post body.
 * @param fileCount How many files are staged.
 * @returns `true` when the draft has a body or at least one file.
 */
export function hasContent(markdown: string, fileCount: number): boolean {
  return markdown.trim().length > 0 || fileCount > 0;
}

/**
 * The first precondition this draft fails, or `null` when nothing local stands in the way.
 *
 * Checked in the order the stages used to run, so a `[POST_COMPOSER] publish failed at <stage>`
 * line keeps meaning what it meant before this function existed.
 *
 * @param contents The composer state.
 * @returns The blocking stage and the sentence for it, or `null` to proceed to the network.
 */
export function localPublishBlocker(contents: ComposerContents): PublishBlocker | null {
  if (!hasContent(contents.markdown, contents.fileCount)) {
    return { stage: 'content', message: m.post_create_content_required() };
  }

  if (contents.includePoll) {
    const options = parsePollOptions(contents.pollOptionsRaw);
    if (!contents.pollQuestion.trim() || options.length < 2) {
      return { stage: 'poll', message: m.post_create_poll_requires_options() };
    }
  }

  if (contents.includeForm && !contents.selectedFormId) {
    return { stage: 'form', message: m.post_create_form_required() };
  }

  return null;
}
