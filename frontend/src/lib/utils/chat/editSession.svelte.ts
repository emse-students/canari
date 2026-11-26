import { SvelteMap } from 'svelte/reactivity';
import { Log } from '$lib/utils/Log';
import { restoreFailedDraft } from '$lib/utils/chat/draftRestore';

/**
 * EDITING A MESSAGE IN THE COMPOSER (user, 2026-10-02: *"modification des messages -> pas dans la
 * bulle, dans le composer de message classique"*).
 *
 * The composer's text belongs to the parent, so starting an edit LOADS the message into it and
 * keeps the draft that was there; leaving - confirming or cancelling - hands the draft back.
 * Editing a typo must not eat the sentence the member was in the middle of.
 *
 * `original` is what the banner shows and what a no-op edit is compared against. Switching straight
 * from one edit to another keeps the FIRST draft - the second edit's starting text is a message, not
 * something the member typed.
 */
export interface EditSessionDeps {
  /** The composer's current text. */
  getText: () => string;
  /** Replaces the composer's text. */
  setText: (text: string) => void;
  /**
   * A writer bound to the draft of the conversation open NOW - called when an edit begins, so a
   * reset can give the draft back to THAT conversation after another one has opened.
   */
  bindDraftWriter: () => (text: string) => void;
  /** The id of the conversation open NOW, read when an edit begins (see {@link holdRestoredText}). */
  conversationKey: () => string | null;
  /** Saves an edit - called once, on confirmation, with a text that really changed. */
  save: (messageId: string, text: string) => void;
}

/** One open edit's way to take a text that comes back for its conversation. */
interface OpenEdit {
  hold: (text: string) => void;
}

/**
 * The edits open NOW, by the conversation they began in. Page memory (no render reads it): it
 * lets a text restored for a conversation (a refused send, a share landing, a taken-back send) find
 * the edit that has replaced that conversation's composer text.
 */
const openEdits = new SvelteMap<string, OpenEdit>();

/**
 * Hands a RESTORED text to the edit open in `conversationKey`, if any, and says whether one took it.
 *
 * WHY IT IS NOT WRITTEN INTO THE COMPOSER: while an edit is open the composer holds the edited
 * message, and `cancel`, `confirm` and `reset` put the draft saved at `begin` back over it - so a
 * text restored into the composer was lost on cancel, or saved as part of the edited message on
 * confirm (review of #2614, 2026-10-27). It joins the SAVED draft instead, in front of what is
 * there, exactly as {@link restoreFailedDraft} does for a plain composer, and comes back with it.
 */
export function holdRestoredText(conversationKey: string, failed: string): boolean {
  const open = openEdits.get(conversationKey);
  if (!open) return false;
  open.hold(failed);
  return true;
}

export function createEditSession(deps: EditSessionDeps) {
  let current = $state<{
    messageId: string;
    original: string;
    /** A media message's caption may be emptied; a text message may not. */
    emptyAllowed: boolean;
    draft: string;
    giveBack: (text: string) => void;
    /** The conversation the edit began in, registered in {@link openEdits}. */
    key: string | null;
  } | null>(null);

  const handle: OpenEdit = {
    hold(text) {
      if (!current) return;
      current.draft = restoreFailedDraft(current.draft, text);
      Log.d('editSession', `a restored text joined the saved draft (${text.length} chars)`);
    },
  };
  /** Takes the session off the registry; only its own entry, never another composer's. */
  function unregister(key: string | null) {
    if (key !== null && openEdits.get(key) === handle) openEdits.delete(key);
  }

  return {
    /** The text of the message being edited, or null - what the composer's banner shows. */
    get original(): string | null {
      return current?.original ?? null;
    },
    /** Whether the edit under way may save an empty text: a media message's caption may be removed. */
    get emptyAllowed(): boolean {
      return current?.emptyAllowed ?? false;
    },
    /**
     * Loads `text` into the composer for editing `messageId`. `captionOnly` says the message carries
     * a media and the text is its caption (owner, 2026-11-11): the photo is not touched by an edit,
     * and the caption may be emptied.
     */
    begin(messageId: string, text: string, captionOnly = false) {
      Log.d('editSession', `begun on ${messageId}${captionOnly ? ' (caption)' : ''}`);
      if (current) {
        current = { ...current, messageId, original: text, emptyAllowed: captionOnly };
      } else {
        const key = deps.conversationKey();
        current = {
          messageId,
          original: text,
          emptyAllowed: captionOnly,
          draft: deps.getText(),
          giveBack: deps.bindDraftWriter(),
          key,
        };
        if (key !== null) openEdits.set(key, handle);
      }
      deps.setText(text);
    },
    /** Abandons the edit and gives the draft back. */
    cancel() {
      if (!current) return;
      Log.d('editSession', `cancelled on ${current.messageId}`);
      const { draft, key } = current;
      current = null;
      unregister(key);
      deps.setText(draft);
    },
    /**
     * Saves the edit and gives the draft back. An unchanged text saves nothing, nor does an empty
     * one unless it removes a caption: the composer disables Save for the same cases, and this is
     * the same rule held where the state lives.
     */
    confirm() {
      if (!current) return;
      const { messageId, original, draft, emptyAllowed, key } = current;
      const text = deps.getText().trim();
      current = null;
      unregister(key);
      deps.setText(draft);
      if ((!text && !emptyAllowed) || text === original.trim()) {
        Log.d('editSession', `nothing to save on ${messageId}`);
        return;
      }
      Log.d('editSession', `saving ${messageId}`);
      deps.save(messageId, text);
    },
    /**
     * The edit's composer went away - the conversation changed, or the page holding it unmounted:
     * the draft goes back to the conversation the edit began in, replacing the message text the
     * edit had loaded there - an edit's text never stays as a draft (2026-10-27). The conversation
     * now open is not touched, and a sign-out in between drops the draft (`bindDraftWriter`).
     */
    reset(why = 'the conversation changed') {
      if (!current) return;
      Log.d('editSession', `dropped on ${current.messageId}: ${why}`);
      const { draft, giveBack, key } = current;
      current = null;
      unregister(key);
      giveBack(draft);
    },
  };
}
