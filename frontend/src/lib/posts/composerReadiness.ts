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
import { pollDraftIssue, type PollDraft, type PollDraftIssue } from './pollDraft';

/** The composer state that can be judged without asking the network anything. */
export interface ComposerContents {
  /** The post body, already trimmed. */
  markdown: string;
  /** How many files are staged for upload. */
  fileCount: number;
  /** The poll being attached, or `null` when the toggle is off. */
  poll: PollDraft | null;
  /**
   * The deadline the poll already carried, when an EXISTING poll is being edited.
   *
   * Left out by the create composer, which has no such thing. See {@link pollDraftIssue}.
   */
  storedPollEndsAt?: string;
  /** The form attachment, or `null` when the toggle is off. */
  form: FormAttachment | null;
}

/** The form attachment as the composer holds it. */
export interface FormAttachment {
  selectedFormId: string;
  /**
   * How many forms this account may attach.
   *
   * IT IS HERE BECAUSE ZERO IS A DIFFERENT SENTENCE. "Veuillez selectionner un formulaire" asks
   * the reader to do something they cannot do when the picker is empty - which is the state the
   * 2026-09-21 reporter's account was in (`GET /api/forms` answered `[]`). A precondition that
   * cannot be met must say so rather than ask again.
   */
  availableCount: number;
}

/** Why this draft cannot be sent, said as the stage that refuses it and the reader's sentence. */
export interface PublishBlocker {
  /** The stage `publishPost` records, so the console line keeps naming WHERE. */
  stage: PublishStage;
  /** Already in the reader's language - it travels as a `LocalizedError`. */
  message: string;
  /**
   * Which field of the poll card is at fault, when the stage is `poll`.
   *
   * The card renders it beside that field, so the reader is not sent looking: a sentence in the
   * banner names the attachment, this names the input.
   */
  pollIssue?: PollDraftIssue;
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

  if (contents.poll) {
    const pollIssue = pollDraftIssue(contents.poll, contents.storedPollEndsAt);
    if (pollIssue) {
      return { stage: 'poll', message: m.post_create_poll_requires_options(), pollIssue };
    }
  }

  if (contents.form && !contents.form.selectedFormId) {
    // Zero forms is not "you have not chosen yet", and asking again for a choice that does not
    // exist is the shape of refusal this whole module was written against.
    return {
      stage: 'form',
      message:
        contents.form.availableCount === 0
          ? m.post_create_form_none_available()
          : m.post_create_form_required(),
    };
  }

  return null;
}
