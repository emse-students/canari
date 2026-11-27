import { MailError } from './mailErrors';
import type { MailActionOp, MailAddress, OutgoingMessage } from './mailTypes';

/**
 * THE ZIMBRA SOAP REQUESTS THIS CLIENT SENDS, AS PURE BUILDERS (docs/wiki/mail-client-transport.md).
 *
 * Each returns the `Body` of one call (`{ SearchRequest: {...} }`), handed to
 * `ZimbraSoapClient.call` by `MailSession`. Pure and silent, so each shape is asserted by a test
 * without a connection; the shapes are the ones measured on partage.emse.fr (Zimbra 9.0.0_ZEXTRAS).
 */

type Body = Record<string, unknown>;

const MAIL = 'urn:zimbraMail';
const ACCOUNT = 'urn:zimbraAccount';

/** `AuthRequest`: the address and the password, answered with a session token. */
export function authRequest(address: string, password: string): Body {
  return {
    AuthRequest: {
      _jsns: ACCOUNT,
      account: { by: 'name', _content: address },
      password: { _content: password },
    },
  };
}

/** `EndSessionRequest`: ends the session on the server (the token stops working). */
export function endSessionRequest(): Body {
  return { EndSessionRequest: { _jsns: ACCOUNT, logoff: '1' } };
}

/** `GetInfoRequest`: the account's canonical name and its attributes (display name). */
export function getInfoRequest(): Body {
  return { GetInfoRequest: { _jsns: ACCOUNT, sections: 'mbox,attrs' } };
}

/** `GetFolderRequest`: the whole folder tree, with counts. */
export function getFolderRequest(): Body {
  return { GetFolderRequest: { _jsns: MAIL } };
}

/** The id of the mailbox root, the parent of every top-level folder (Zimbra's fixed `1`). */
export const ROOT_FOLDER_ID = '1';

/**
 * `CreateFolderRequest`: a mail folder `name` under `parentId` (the root by default), in the mail
 * (`message`) view the system folders carry. `fie: 1` ("fetch if exists") answers with the folder already
 * there instead of a `mail.ALREADY_EXISTS` fault, so a second device that created it first, or a
 * press repeated, lands on the same folder.
 */
export function createFolderRequest(name: string, parentId: string = ROOT_FOLDER_ID): Body {
  return {
    CreateFolderRequest: {
      _jsns: MAIL,
      folder: { name, l: parentId, view: 'message', fie: 1 },
    },
  };
}

/** What a list asks for. */
export interface SearchOptions {
  /** The folder listed; `null` searches the whole mailbox. */
  folderId: string | null;
  /** The reader's search, in Zimbra's query syntax; empty lists the folder. */
  query: string;
  offset: number;
  limit: number;
}

/**
 * The Zimbra query for `options`: the folder by ID (`inid:`, never by name - the system folders'
 * names are localised on the server), AND the reader's own query in parentheses, so its `or` cannot
 * escape the folder.
 */
export function searchQuery(options: Pick<SearchOptions, 'folderId' | 'query'>): string {
  const parts: string[] = [];
  if (options.folderId !== null) parts.push(`inid:${quoteSearchValue(options.folderId)}`);
  const own = options.query.trim();
  if (own) {
    if (!parenthesesBalanced(own)) throw new MailError('invalid_query', 'unbalanced-parentheses');
    parts.push(`(${own})`);
  }
  return parts.length ? parts.join(' ') : 'is:anywhere';
}

/**
 * A value quoted for Zimbra's query language (`subject:${quoteSearchValue(text)}`): in double quotes,
 * the backslash and the quote escaped, so a value can never close its quotes and add a term.
 */
export function quoteSearchValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Whether `query`'s parentheses balance outside quoted values. An unbalanced `)` would close the
 * parentheses {@link searchQuery} puts around the reader's query and let it escape the folder.
 */
export function parenthesesBalanced(query: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0 && !quoted;
}

/** `SearchRequest` for a page of conversations or of messages, newest first. */
export function searchRequest(types: 'conversation' | 'message', options: SearchOptions): Body {
  return {
    SearchRequest: {
      _jsns: MAIL,
      query: searchQuery(options),
      types,
      sortBy: 'dateDesc',
      offset: options.offset,
      limit: options.limit,
    },
  };
}

/** `GetConvRequest`: every message of a conversation, with its HTML body (defanged). */
export function getConvRequest(id: string): Body {
  return { GetConvRequest: { _jsns: MAIL, c: { id, fetch: 'all', html: 1 } } };
}

/** `GetMsgRequest`: one message, with its HTML body (defanged by Zimbra). */
export function getMsgRequest(id: string): Body {
  return { GetMsgRequest: { _jsns: MAIL, m: { id, html: 1 } } };
}

/** Zimbra's `op` for each action. */
const ACTION_OPS: Record<MailActionOp, string> = {
  read: 'read',
  unread: '!read',
  flag: 'flag',
  unflag: '!flag',
  move: 'move',
  trash: 'trash',
  spam: 'spam',
  not_spam: '!spam',
  delete: 'delete',
};

/** Which items an action targets: messages (`MsgAction`) or whole conversations (`ConvAction`). */
export type ActionTarget = 'message' | 'conversation';

/** The letters Zimbra's `tcon` uses for the folders a conversation action may leave alone. */
const TCON_LETTERS: Partial<Record<string, string>> = {
  trash: 't',
  junk: 'j',
  sent: 's',
  drafts: 'd',
};

/**
 * The target constraint of a conversation action listed from `role`'s folder: every message of the
 * conversation EXCEPT those in Trash, Junk, Sent and Drafts - unless that is the folder listed. So
 * trashing a conversation from the inbox leaves the account's own sent replies where they are, and
 * moving one out of the trash does not pull its sent copies along - the webmail's own rule.
 */
export function conversationConstraint(role: string | null): string {
  const letters = Object.entries(TCON_LETTERS)
    .filter(([folder]) => folder !== role)
    .map(([, letter]) => letter)
    .join('');
  return `-${letters}`;
}

/**
 * `MsgActionRequest` or `ConvActionRequest` applying `op` to every id at once (bulk), with the
 * destination folder for `move` and `not_spam`, and the target constraint for a conversation.
 */
export function actionRequest(
  target: ActionTarget,
  op: MailActionOp,
  ids: readonly string[],
  extra: { folderId?: string; constraint?: string } = {}
): Body {
  const action: Record<string, unknown> = { op: ACTION_OPS[op], id: ids.join(',') };
  if (extra.folderId !== undefined) action.l = extra.folderId;
  if (target === 'conversation' && extra.constraint) action.tcon = extra.constraint;
  return target === 'message'
    ? { MsgActionRequest: { _jsns: MAIL, action } }
    : { ConvActionRequest: { _jsns: MAIL, action } };
}

/** One address as Zimbra's `e` element (`t`: t to, c cc, b bcc). */
function addressElement(type: 't' | 'c' | 'b', address: MailAddress): Record<string, string> {
  return address.name
    ? { t: type, a: address.address, p: address.name }
    : { t: type, a: address.address };
}

/** The `m` element shared by `SendMsg` and `SaveDraft`. */
export function messageElement(message: OutgoingMessage): Record<string, unknown> {
  const m: Record<string, unknown> = {
    e: [
      ...message.to.map((a) => addressElement('t', a)),
      ...message.cc.map((a) => addressElement('c', a)),
      ...message.bcc.map((a) => addressElement('b', a)),
    ],
    su: { _content: message.subject },
    mp: [
      message.html === null
        ? { ct: 'text/plain', content: { _content: message.text } }
        : {
            ct: 'multipart/alternative',
            mp: [
              { ct: 'text/plain', content: { _content: message.text } },
              { ct: 'text/html', content: { _content: message.html } },
            ],
          },
    ],
  };
  if (message.attachments.length || message.forwardedParts.length) {
    const attach: Record<string, unknown> = {};
    if (message.attachments.length) {
      attach.aid = message.attachments.map((a) => a.uploadId).join(',');
    }
    if (message.forwardedParts.length) {
      attach.mp = message.forwardedParts.map((p) => ({ mid: p.messageId, part: p.part }));
    }
    m.attach = attach;
  }
  if (message.origin) {
    m.origid = message.origin.messageId;
    m.rt = message.origin.kind === 'reply' ? 'r' : 'w';
    if (message.origin.messageIdHeader) m.irt = { _content: message.origin.messageIdHeader };
  }
  return m;
}

/** `SendMsgRequest`: sends `message`, and deletes the draft it was saved as (`did`). */
export function sendMsgRequest(message: OutgoingMessage): Body {
  const m = messageElement(message);
  if (message.draftId) m.did = message.draftId;
  return { SendMsgRequest: { _jsns: MAIL, suid: message.suid, m } };
}

/** `SaveDraftRequest`: saves `message` as a draft, over the draft it already is (`id`). */
export function saveDraftRequest(message: OutgoingMessage): Body {
  const m = messageElement(message);
  if (message.draftId) m.id = message.draftId;
  return { SaveDraftRequest: { _jsns: MAIL, m } };
}

/** `AutoCompleteRequest`: addresses matching `name`, the school directory (GAL) included. */
export function autoCompleteRequest(name: string): Body {
  return { AutoCompleteRequest: { _jsns: MAIL, name, includeGal: 1 } };
}
