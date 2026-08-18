/**
 * WHAT a server-composed push says, never the sentence that says it.
 *
 * The services are the one layer that does not know the recipient's language: no header carries it
 * and no column stores it. Every sentence here used to be composed server-side anyway - the post
 * notifications in French, the form reminders in English - so a French user got English reminders
 * and an English user got French comments, and neither could be fixed by translating anything.
 *
 * So the composition MOVES. A push now carries a `contentKey` from the closed set below plus at
 * most two pieces of data that are not translatable - a person's name and one variable fragment -
 * and the device builds the sentence from its own two-language table (`strings.xml` /
 * `Localizable.strings`), through the locale the user chose inside Canari. This is exactly what the
 * message-reaction push already does; it is the only push that was right, and this makes it the
 * rule rather than the exception.
 *
 * Storing a `locale` column server-side would be the wrong repair: it would make the server
 * authoritative about a preference that lives in the app, and leave every future sentence composed
 * in the one place that cannot know who is reading.
 */

/** The closed set of sentences a server-composed push may be. Native tables key off these. */
export type PushContentKey =
  | 'social_mention'
  | 'social_reply'
  | 'social_comment'
  | 'social_reaction'
  | 'form_opening_soon'
  | 'form_open';

/**
 * One push's content, as data rather than prose.
 *
 * `legacyTitle` / `legacyBody` are the sentences as they read today, sent ALONGSIDE the key for
 * clients built before 2026-08-19, which read `title` and `body` and know nothing of `contentKey`.
 * Dropping them would blank the notification on every phone already installed. They come out with
 * the shim - see `docs/wiki/legacy-compatibility.md`.
 */
export type PushContent = {
  key: PushContentKey;
  /** A person's name. Never translated, and empty when nobody in particular acted. */
  actorName: string;
  /**
   * The one variable fragment, and what it means is fixed per key:
   * - `social_mention` / `social_reply` / `social_comment`: the text the author typed
   * - `social_reaction`: the reaction itself (an emoji)
   * - the two form keys: nothing, always empty
   */
  arg: string;
  legacyTitle: string;
  legacyBody: string;
};

/** Someone mentioned the recipient. */
export function mentionContent(actorName: string, preview: string): PushContent {
  return {
    key: 'social_mention',
    actorName,
    arg: preview,
    legacyTitle: `${actorName} vous a mentionné`,
    legacyBody: preview || 'Vous avez été mentionné dans un commentaire',
  };
}

/** Someone replied to the recipient's comment. */
export function replyContent(actorName: string, preview: string): PushContent {
  return {
    key: 'social_reply',
    actorName,
    arg: preview,
    legacyTitle: `${actorName} a répondu`,
    legacyBody: preview || 'Nouvelle réponse',
  };
}

/** Someone commented on the recipient's post. */
export function commentContent(actorName: string, preview: string): PushContent {
  return {
    key: 'social_comment',
    actorName,
    arg: preview,
    legacyTitle: `${actorName} a commenté`,
    legacyBody: preview || 'Nouveau commentaire',
  };
}

/**
 * Someone reacted to the recipient's post.
 *
 * The only key whose TITLE names no actor, so the actor travels in the body instead - which is why
 * the native side composes title and body per key rather than from one shared shape.
 */
export function reactionContent(actorName: string, reaction: string): PushContent {
  return {
    key: 'social_reaction',
    actorName,
    arg: reaction,
    legacyTitle: 'Nouvelle réaction',
    legacyBody: `${actorName} a réagi ${reaction} à votre publication`,
  };
}

/** A watched form opens in five minutes. Nobody acted, so there is no actor. */
export function formOpeningSoonContent(): PushContent {
  return {
    key: 'form_opening_soon',
    actorName: '',
    arg: '',
    // English, unlike every other sentence here, and for the same underlying reason: whoever wrote
    // it picked a language for everyone. It goes out with the shim like the rest.
    legacyTitle: 'Form opening soon',
    legacyBody: 'A form you are watching opens in 5 minutes!',
  };
}

/** A watched form is now open. */
export function formOpenContent(): PushContent {
  return {
    key: 'form_open',
    actorName: '',
    arg: '',
    legacyTitle: 'Form now open!',
    legacyBody: 'The form is available - hurry, spots are limited!',
  };
}

/** The structured half of the FCM data payload, merged into whatever the caller already sends. */
export function pushContentData(content: PushContent): Record<string, string> {
  return {
    contentKey: content.key,
    actorName: content.actorName,
    contentArg: content.arg,
  };
}
