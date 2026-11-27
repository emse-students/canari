import { MailError } from './mailErrors';
import type {
  AttachmentRef,
  ConversationSummary,
  DirectoryMatch,
  FolderRole,
  ItemFlags,
  MailAccount,
  MailAddress,
  MailConversation,
  MailFolder,
  MailMessage,
  MessageSummary,
  Page,
  UploadedAttachment,
} from './mailTypes';

/**
 * ZIMBRA'S JSON ANSWERS, READ INTO THE DOMAIN TYPES (`mailTypes.ts`).
 *
 * Every abbreviation Zimbra uses is read here and only here. A field Zimbra leaves out is its
 * default (a folder with no `u` has 0 unread - measured: the key is ABSENT when 0). An answer that
 * lacks what the call is for (an `AuthResponse` with no token) is a {@link MailError} `server`, typed
 * at the throw - never an empty result standing in for a broken one.
 */

type Json = Record<string, unknown>;

/** Zimbra sends a single element as an object or as a one-element array, depending on the call. */
function list(value: unknown): Json[] {
  if (Array.isArray(value)) return value.filter((v): v is Json => !!v && typeof v === 'object');
  return value && typeof value === 'object' ? [value as Json] : [];
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** `{ _content: "x" }` (or an array of one) to `"x"`. */
function content(value: unknown): string | null {
  const first = list(value)[0];
  return first ? str(first._content) : str(value);
}

/** The response element `name` of a SOAP body, or a typed refusal when it is missing. */
export function responseOf(body: Json, name: string): Json {
  const response = body[name];
  if (!response || typeof response !== 'object') {
    throw new MailError('server', `malformed-${name}`);
  }
  return response as Json;
}

/** Zimbra's flag string (`ufa`) read into {@link ItemFlags}. */
export function parseFlags(flags: unknown): ItemFlags {
  const f = typeof flags === 'string' ? flags : '';
  return {
    unread: f.includes('u'),
    flagged: f.includes('f'),
    attachment: f.includes('a'),
    replied: f.includes('r'),
    forwarded: f.includes('w'),
    draft: f.includes('d'),
  };
}

/** One `e` element (`{a, p, d, t}`) as an address. */
function addressOf(e: Json): MailAddress | null {
  const address = str(e.a);
  if (!address) return null;
  return { address, name: str(e.p) };
}

/** The addresses of type `t` (`f` from, `t` to, `c` cc, `r` reply-to) in an `e` list. */
function addresses(e: unknown, type: string): MailAddress[] {
  return list(e)
    .filter((x) => x.t === type)
    .map(addressOf)
    .filter((a): a is MailAddress => a !== null);
}

/**
 * One RFC 5322 mailbox as the autocomplete writes it - `"Name" <a@b>`, `Name <a@b>` or `a@b` - into
 * an address. `null` when there is no address in it.
 */
export function parseMailbox(text: string): MailAddress | null {
  const angle = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<]*?))\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(text);
  if (angle) {
    const name = (angle[1] ?? angle[2] ?? '').replace(/\\(.)/g, '$1').trim();
    return { address: angle[3], name: name || null };
  }
  const bare = text.trim();
  return /^[^\s<>"]+@[^\s<>"]+$/.test(bare) ? { address: bare, name: null } : null;
}

/** `AuthResponse`: the session token. */
export function parseAuth(body: Json): { token: string } {
  const response = responseOf(body, 'AuthResponse');
  const token = content(response.authToken);
  if (!token) throw new MailError('server', 'malformed-AuthResponse-token');
  return { token };
}

/** `GetInfoResponse`: the account's canonical address and display name. */
export function parseInfo(body: Json): MailAccount {
  const response = responseOf(body, 'GetInfoResponse');
  const address = str(response.name);
  if (!address) throw new MailError('server', 'malformed-GetInfoResponse-name');
  const attrs = (response.attrs as { _attrs?: Json } | undefined)?._attrs ?? {};
  const displayName = str(attrs.displayName);
  return { address, displayName: displayName || null };
}

/** Zimbra's fixed ids of the system folders. */
const SYSTEM_ROLES: Readonly<Record<string, FolderRole>> = {
  '2': 'inbox',
  '3': 'trash',
  '4': 'junk',
  '5': 'sent',
  '6': 'drafts',
};

/** Folder views that hold mail (a folder with no view is a mail folder). */
const MAIL_VIEWS = new Set(['message', 'conversation']);

function folderOf(f: Json, parentId: string | null): MailFolder | null {
  const id = str(f.id);
  if (!id) return null;
  const view = str(f.view);
  if (view !== null && !MAIL_VIEWS.has(view)) return null;
  const name = str(f.name) ?? id;
  return {
    id,
    name,
    path: str(f.absFolderPath) ?? `/${name}`,
    parentId,
    role: SYSTEM_ROLES[id] ?? null,
    total: num(f.n),
    unread: num(f.u),
    children: list(f.folder)
      .map((c) => folderOf(c, id))
      .filter((c): c is MailFolder => c !== null),
  };
}

/**
 * `GetFolderResponse`: the mail folders under the mailbox root (calendars, contacts and briefcases
 * left out, and so are their mail subfolders - none is expected there).
 */
export function parseFolders(body: Json): MailFolder[] {
  const response = responseOf(body, 'GetFolderResponse');
  const root = list(response.folder)[0];
  if (!root) throw new MailError('server', 'malformed-GetFolderResponse-root');
  return list(root.folder)
    .map((f) => folderOf(f, null))
    .filter((f): f is MailFolder => f !== null);
}

/** Every folder of a tree, depth first. */
export function flattenFolders(folders: readonly MailFolder[]): MailFolder[] {
  return folders.flatMap((f) => [f, ...flattenFolders(f.children)]);
}

function conversationOf(c: Json): ConversationSummary | null {
  const id = str(c.id);
  if (!id) return null;
  return {
    id,
    subject: str(c.su) ?? '',
    fragment: str(c.fr) ?? '',
    date: num(c.d),
    messageCount: num(c.n),
    unreadCount: num(c.u),
    senders: addresses(c.e, 'f'),
    flags: parseFlags(c.f),
  };
}

function messageSummaryOf(m: Json): MessageSummary | null {
  const id = str(m.id);
  if (!id) return null;
  return {
    id,
    conversationId: str(m.cid),
    folderId: str(m.l) ?? '',
    subject: str(m.su) ?? '',
    fragment: str(m.fr) ?? '',
    date: num(m.d),
    from: addresses(m.e, 'f')[0] ?? null,
    to: addresses(m.e, 't'),
    flags: parseFlags(m.f),
  };
}

/** `SearchResponse` of a conversation search, as one page. */
export function parseConversationPage(body: Json, offset: number): Page<ConversationSummary> {
  const response = responseOf(body, 'SearchResponse');
  return {
    items: list(response.c)
      .map(conversationOf)
      .filter((c): c is ConversationSummary => c !== null),
    offset,
    hasMore: response.more === true,
  };
}

/** `SearchResponse` of a message search, as one page. */
export function parseMessagePage(body: Json, offset: number): Page<MessageSummary> {
  const response = responseOf(body, 'SearchResponse');
  return {
    items: list(response.m)
      .map(messageSummaryOf)
      .filter((m): m is MessageSummary => m !== null),
    offset,
    hasMore: response.more === true,
  };
}

/** The bodies and the attachments of a message's MIME tree. */
function readParts(
  messageId: string,
  parts: Json[]
): { html: string | null; text: string | null; attachments: AttachmentRef[] } {
  let html: string | null = null;
  let text: string | null = null;
  const attachments: AttachmentRef[] = [];
  const walk = (nodes: Json[]) => {
    for (const p of nodes) {
      const ct = (str(p.ct) ?? '').toLowerCase();
      const children = list(p.mp);
      if (children.length || ct.startsWith('multipart/')) {
        walk(children);
        continue;
      }
      const body = p.body === true;
      const disposition = (str(p.cd) ?? '').toLowerCase();
      const filename = str(p.filename);
      const partContent = str(p.content);
      if (body && partContent !== null && ct === 'text/html' && html === null) html = partContent;
      else if (partContent !== null && ct === 'text/plain' && text === null && !filename) {
        text = partContent;
      }
      if (body || (disposition !== 'attachment' && !filename)) continue;
      const part = str(p.part);
      if (!part) continue;
      const contentId = str(p.ci)?.replace(/^<|>$/g, '') ?? null;
      attachments.push({
        messageId,
        part,
        filename: filename ?? part,
        contentType: ct || 'application/octet-stream',
        size: num(p.s),
        contentId,
        inline: disposition === 'inline' && contentId !== null,
      });
    }
  };
  walk(parts);
  return { html, text, attachments };
}

/** One `m` element of `GetMsg` / `GetConv`, whole. */
export function messageOf(m: Json): MailMessage {
  const summary = messageSummaryOf(m);
  if (!summary) throw new MailError('server', 'malformed-message-id');
  return {
    ...summary,
    cc: addresses(m.e, 'c'),
    replyTo: addresses(m.e, 'r'),
    messageIdHeader: str(m.mid),
    ...readParts(summary.id, list(m.mp)),
  };
}

/** `GetMsgResponse`: the message. */
export function parseMessage(body: Json): MailMessage {
  const m = list(responseOf(body, 'GetMsgResponse').m)[0];
  if (!m) throw new MailError('server', 'malformed-GetMsgResponse-m');
  return messageOf(m);
}

/** `GetConvResponse`: the conversation and its messages, oldest first. */
export function parseConversation(body: Json): MailConversation {
  const c = list(responseOf(body, 'GetConvResponse').c)[0];
  const id = c && str(c.id);
  if (!c || !id) throw new MailError('server', 'malformed-GetConvResponse-c');
  const messages = list(c.m)
    .map(messageOf)
    .sort((a, b) => a.date - b.date);
  return { id, subject: str(c.su) ?? messages[0]?.subject ?? '', messages };
}

/** `SendMsgResponse` / `SaveDraftResponse`: the id of the message written. */
export function parseWrittenMessageId(body: Json, name: string): string {
  const id = str(list(responseOf(body, name).m)[0]?.id);
  if (!id) throw new MailError('server', `malformed-${name}-id`);
  return id;
}

/** Zimbra's autocomplete `type` to where a suggestion comes from. */
const MATCH_SOURCES: Readonly<Record<string, DirectoryMatch['source']>> = {
  gal: 'directory',
  contact: 'contact',
  rankingTable: 'recent',
};

/** `AutoCompleteResponse`: the suggestions, each one address. */
export function parseAutoComplete(body: Json): DirectoryMatch[] {
  const response = responseOf(body, 'AutoCompleteResponse');
  const out: DirectoryMatch[] = [];
  for (const match of list(response.match)) {
    const mailbox = parseMailbox(str(match.email) ?? '');
    if (!mailbox) continue;
    out.push({ ...mailbox, source: MATCH_SOURCES[str(match.type) ?? ''] ?? 'contact' });
  }
  return out;
}

/**
 * The upload servlet's answer with `fmt=raw,extended`:
 * `200,'null',[{"aid":"...","ct":"...","filename":"...","s":123}]`. The leading number is the
 * servlet's own status: anything but 200 is returned for the caller to classify.
 */
export function parseUploadAnswer(text: string): { status: number; uploads: UploadedAttachment[] } {
  const match = /^\s*(\d{3})\s*,\s*'[^']*'\s*(?:,\s*([\s\S]*))?$/.exec(text);
  if (!match) throw new MailError('server', 'malformed-upload-answer');
  const status = Number(match[1]);
  if (status !== 200) return { status, uploads: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse((match[2] ?? '').trim());
  } catch (err) {
    throw new MailError('server', 'malformed-upload-json', err);
  }
  const uploads = list(parsed).map((u) => {
    const uploadId = str(u.aid);
    if (!uploadId) throw new MailError('server', 'malformed-upload-aid');
    return {
      uploadId,
      filename: str(u.filename) ?? '',
      contentType: str(u.ct) ?? 'application/octet-stream',
      size: num(u.s),
    };
  });
  return { status, uploads };
}
