import { Log } from '$lib/utils/Log';

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
  /** Saves an edit - called once, on confirmation, with a text that really changed. */
  save: (messageId: string, text: string) => void;
}

export function createEditSession(deps: EditSessionDeps) {
  let current = $state<{ messageId: string; original: string; draft: string } | null>(null);

  return {
    /** The text of the message being edited, or null - what the composer's banner shows. */
    get original(): string | null {
      return current?.original ?? null;
    },
    /** Loads `text` into the composer for editing `messageId`. */
    begin(messageId: string, text: string) {
      Log.d('editSession', `begun on ${messageId}`);
      current = { messageId, original: text, draft: current ? current.draft : deps.getText() };
      deps.setText(text);
    },
    /** Abandons the edit and gives the draft back. */
    cancel() {
      if (!current) return;
      Log.d('editSession', `cancelled on ${current.messageId}`);
      const { draft } = current;
      current = null;
      deps.setText(draft);
    },
    /**
     * Saves the edit and gives the draft back. An empty or unchanged text saves nothing: the
     * composer disables Save for both, and this is the same rule held where the state lives.
     */
    confirm() {
      if (!current) return;
      const { messageId, original, draft } = current;
      const text = deps.getText().trim();
      current = null;
      deps.setText(draft);
      if (!text || text === original.trim()) {
        Log.d('editSession', `nothing to save on ${messageId}`);
        return;
      }
      Log.d('editSession', `saving ${messageId}`);
      deps.save(messageId, text);
    },
    /** Drops the edit WITHOUT touching the text - the conversation changed and the text went with it. */
    reset() {
      current = null;
    },
  };
}
