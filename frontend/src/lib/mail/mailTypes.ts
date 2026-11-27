/**
 * THE MAIL CLIENT'S DOMAIN TYPES (docs/wiki/mail-client-transport.md#as-built---lot-2).
 *
 * What the screens of lot 3 read, decoupled from Zimbra's JSON: every field Zimbra abbreviates
 * (`su`, `fr`, `e[]`, `f`) is named here once, by `zimbraParse.ts`, and nowhere else. Ids are
 * Zimbra's own item ids, kept as strings (Zimbra sends them as strings and a shared mailbox prefixes
 * them with an account id).
 */

/** One address, with the display name when the mail carried one. */
export interface MailAddress {
  address: string;
  name: string | null;
}

/** The system folders Zimbra numbers itself (2, 5, 6, 3, 4): the ones the screens name. */
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk';

/** A mail folder, with its children (the tree the folder list draws). */
export interface MailFolder {
  id: string;
  name: string;
  /** Zimbra's absolute path (`/Inbox/School`), unique in the mailbox. */
  path: string;
  /** The parent's id; `null` under the mailbox root. */
  parentId: string | null;
  role: FolderRole | null;
  /** Messages in the folder (Zimbra's `n`). */
  total: number;
  /** Unread messages (Zimbra's `u`, ABSENT when 0). */
  unread: number;
  children: MailFolder[];
}

/** The flags of a message or conversation, from Zimbra's flag string. */
export interface ItemFlags {
  unread: boolean;
  flagged: boolean;
  attachment: boolean;
  replied: boolean;
  forwarded: boolean;
  draft: boolean;
}

/** One row of a conversation list. */
export interface ConversationSummary {
  id: string;
  subject: string;
  /** The first characters of the newest message, as Zimbra cut them. */
  fragment: string;
  /** The newest message's date, ms since the epoch. */
  date: number;
  messageCount: number;
  unreadCount: number;
  /** The senders, newest first, as Zimbra lists them. */
  senders: MailAddress[];
  flags: ItemFlags;
}

/** One row of a message list (a folder read by message: Drafts, Sent). */
export interface MessageSummary {
  id: string;
  conversationId: string | null;
  folderId: string;
  subject: string;
  fragment: string;
  date: number;
  from: MailAddress | null;
  to: MailAddress[];
  flags: ItemFlags;
}

/** One page of a list, and whether the server holds more after it. */
export interface Page<T> {
  items: T[];
  offset: number;
  hasMore: boolean;
}

/** A part of a message the reader can download (or an inline image the body names). */
export interface AttachmentRef {
  messageId: string;
  /** Zimbra's MIME part id (`2`, `2.1`). */
  part: string;
  filename: string;
  contentType: string;
  size: number;
  /** The `Content-ID` an HTML body refers to (`cid:`), without its angle brackets. */
  contentId: string | null;
  /** Shown inside the body (`Content-Disposition: inline` with a `Content-ID`), not listed. */
  inline: boolean;
}

/** A whole message, as the reader shows it. */
export interface MailMessage extends MessageSummary {
  cc: MailAddress[];
  replyTo: MailAddress[];
  /** The `Message-ID` header, which a reply names in `In-Reply-To`. */
  messageIdHeader: string | null;
  /** Zimbra's DEFANGED HTML body (D9: lot 3 still shows it sandboxed), when the mail has one. */
  html: string | null;
  /** The plain-text body, when the mail has one. */
  text: string | null;
  attachments: AttachmentRef[];
}

/** A conversation opened: its messages, oldest first. */
export interface MailConversation {
  id: string;
  subject: string;
  messages: MailMessage[];
}

/** The signed-in mailbox. */
export interface MailAccount {
  /** The account's canonical address, as Zimbra names it (`GetInfo.name`). */
  address: string;
  displayName: string | null;
  /** The account's other addresses (`zimbraMailAlias`): mail to them is mail to the account. */
  aliases: string[];
}

/** A file uploaded to Zimbra, attached by its upload id when the message is sent or saved. */
export interface UploadedAttachment {
  uploadId: string;
  filename: string;
  contentType: string;
  size: number;
}

/** An existing part of a message, carried into a forward or a draft without downloading it. */
export interface ForwardedPart {
  messageId: string;
  part: string;
}

/** A message being written: what `SendMsg` and `SaveDraft` carry. */
export interface OutgoingMessage {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  /** The plain-text body; always sent. */
  text: string;
  /** The HTML body; sent beside the text as `multipart/alternative` when set. */
  html: string | null;
  attachments: UploadedAttachment[];
  forwardedParts: ForwardedPart[];
  /** What this message answers, so Zimbra threads it and flags the original replied/forwarded. */
  origin: { kind: 'reply' | 'forward'; messageId: string; messageIdHeader: string | null } | null;
  /** The draft this message was saved as: a send deletes it, a save overwrites it. */
  draftId: string | null;
  /**
   * A unique id for THIS message, sent with `SendMsg` (`suid`): Zimbra refuses to send the same one
   * twice, so a send resent after a renewal, or by a second press, cannot go out twice.
   */
  suid: string;
}

/** One suggestion of the address autocomplete. */
export interface DirectoryMatch {
  address: string;
  name: string | null;
  /** `directory` is the school's address book (GAL); `contact` the account's own; `recent` used before. */
  source: 'directory' | 'contact' | 'recent';
}

/** What a mail action does, as a word the screens pass (one Zimbra `op` each). */
export type MailActionOp =
  | 'read'
  | 'unread'
  | 'flag'
  | 'unflag'
  | 'move'
  | 'trash'
  | 'spam'
  | 'not_spam'
  | 'delete';
