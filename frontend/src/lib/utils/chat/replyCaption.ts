import { m } from '$lib/paraglide/messages';
import { Log } from '$lib/utils/Log';

/** What {@link replyCaption} needs to say who answered whom. */
export interface ReplyCaptionInput {
  /** True when the sender's name is already drawn above the bubble (a group's first bubble). */
  headerShown: boolean;
  /** True when the reply is the reader's own message. */
  isOwn: boolean;
  /** Author id of the reply. */
  replierId: string;
  /** Author id of the quoted message. */
  quotedId: string;
  /** The reader's id, to tell "you" from a named person when the quote is the reader's. */
  currentUserId: string;
  /** Given name of the replier (read only when not own). */
  replierName: string;
  /** Given name of the quoted author; '' when unknown (the caption then names nobody). */
  quotedName: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * THE ONE LINE ABOVE A QUOTE, SAYING WHO ANSWERED WHOM, WITHOUT REPEATING WHAT IS ALREADY ON SCREEN.
 *
 * In a group the sender header sits right above this line, so naming the replier again printed the
 * same name twice in a row ("Alice" then "Alice a répondu"). When the header is shown the line
 * drops the replier and names the quoted author ("A répondu à Bob"); a self-quote is "son message",
 * gender-neutral. Without a header (own messages, 1:1, a run's later bubbles) the line stays
 * self-contained and names both.
 */
export function replyCaption(i: ReplyCaptionInput): string {
  const quotedKnown = i.quotedName.trim() !== '';
  const quotedIsReplier = same(i.quotedId, i.replierId);
  const quotedIsReader = !!i.currentUserId && same(i.quotedId, i.currentUserId);
  let key: string;
  let text: string;
  if (i.headerShown && !i.isOwn) {
    if (quotedIsReplier) {
      key = 'shown_self';
      text = m.msg_reply_caption_shown_self();
    } else if (quotedIsReader) {
      key = 'shown_you';
      text = m.msg_reply_caption_shown_you();
    } else if (!quotedKnown) {
      key = 'shown_nameless';
      text = m.msg_reply_caption_shown_nameless();
    } else {
      key = 'shown_other';
      text = m.msg_reply_caption_shown_other({ quoted: i.quotedName });
    }
  } else if (i.isOwn) {
    if (quotedIsReplier || quotedIsReader) {
      key = 'you_to_self';
      text = m.msg_reply_caption_you_to_self();
    } else if (!quotedKnown) {
      key = 'you_nameless';
      text = m.msg_reply_caption_you_nameless();
    } else {
      key = 'you_to_other';
      text = m.msg_reply_caption_you_to_other({ quoted: i.quotedName });
    }
  } else if (quotedIsReplier) {
    key = 'other_to_self';
    text = m.msg_reply_caption_other_to_self({ name: i.replierName });
  } else if (quotedIsReader) {
    key = 'other_to_you';
    text = m.msg_reply_caption_other_to_you({ name: i.replierName });
  } else if (!quotedKnown) {
    key = 'other_nameless';
    text = m.msg_reply_caption_other_nameless({ name: i.replierName });
  } else {
    key = 'other_to_other';
    text = m.msg_reply_caption_other_to_other({ name: i.replierName, quoted: i.quotedName });
  }
  // Only the name-less fallback is a decision worth a line: the quoted author could not be named.
  if (key.endsWith('nameless')) Log.d('[replyCaption] quoted author unknown, name-less form', key);
  return text;
}
