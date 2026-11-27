import type { OutgoingMessage } from './mailTypes';

/**
 * What a mail list shows: one folder by id, or the "Suivis" view - every flagged conversation of the
 * mailbox, whatever its folder (docs/wiki/mail-client-transport.md#as-built---lot-3).
 */
export type MailView = { kind: 'folder'; folderId: string } | { kind: 'flagged' };

/** The folder a view lists (`null`: the whole mailbox) and the search term it adds. */
export function viewScope(view: MailView): { folderId: string | null; term: string } {
  return view.kind === 'folder'
    ? { folderId: view.folderId, term: '' }
    : { folderId: null, term: 'is:flagged' };
}

/**
 * What a press on the actions of a selection or of an open conversation asks: an action of the
 * store (`MailActionOp`), "archive" (a move to the archive folder), or "more" / "move" (a sheet).
 */
export type MailUiAction =
  | 'archive'
  | 'trash'
  | 'read'
  | 'unread'
  | 'flag'
  | 'unflag'
  | 'spam'
  | 'not_spam'
  | 'delete'
  | 'move';

/** A composer open: the message it starts from and its title. */
export interface MailComposeState {
  initial: OutgoingMessage;
  title: string;
}
