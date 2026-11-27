import { Log } from '$lib/utils/Log';
import type { HttpResponse } from './http1';
import { MailError } from './mailErrors';
import type { MailSession } from './mailSession';
import type {
  AttachmentRef,
  ConversationSummary,
  DirectoryMatch,
  MailAccount,
  MailActionOp,
  MailConversation,
  MailFolder,
  MailMessage,
  MessageSummary,
  OutgoingMessage,
  Page,
  UploadedAttachment,
} from './mailTypes';
import {
  parseAutoComplete,
  parseConversation,
  parseConversationPage,
  parseFolders,
  parseInfo,
  parseMessage,
  parseMessagePage,
  parseUploadAnswer,
  parseWrittenMessageId,
} from './zimbraParse';
import {
  actionRequest,
  autoCompleteRequest,
  conversationConstraint,
  getConvRequest,
  getFolderRequest,
  getInfoRequest,
  getMsgRequest,
  saveDraftRequest,
  searchRequest,
  sendMsgRequest,
  type ActionTarget,
  type SearchOptions,
} from './zimbraRequests';

/**
 * THE MAILBOX, AS THE SCREENS USE IT (docs/wiki/mail-client-transport.md#as-built---lot-2).
 *
 * Every method is one or two calls through the {@link MailSession} - which owns the token, its
 * renewal and the classification of failures - and returns the domain types of `mailTypes.ts`.
 * Bulk actions are ONE call for every id (Zimbra's `id` list), never a loop of calls.
 */

/** Zimbra's upload servlet, answering in the `raw,extended` format `parseUploadAnswer` reads. */
const UPLOAD_PATH = '/service/upload?fmt=raw,extended';
/** A `Content-Type` this client passes through as it is; anything else is sent as octets. */
const SAFE_CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

/** A file to attach. */
export interface FileToUpload {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * A filename for `Content-Disposition`, written the way Zimbra's own web client writes it: every
 * character outside printable ASCII, and the quote, the ampersand and the backslash, as an HTML numeric entity,
 * which the upload servlet decodes. No line break can reach the header.
 */
export function uploadFilename(filename: string): string {
  let out = '';
  for (const char of filename) {
    const code = char.codePointAt(0) ?? 0;
    out +=
      code < 0x20 || code > 0x7e || char === '"' || char === '&' || char === '\\'
        ? `&#${code};`
        : char;
  }
  return out;
}

/** The typed failure of a plain HTTP answer from the mailbox (upload, download). */
export function httpStatusFailure(status: number, what: string): MailError {
  if (status === 401) return new MailError('session_expired', `${what}-401`);
  if (status === 404) return new MailError('not_found', `${what}-404`);
  if (status === 413) return new MailError('too_large', `${what}-413`);
  return new MailError('server', `${what}-${status}`);
}

function readUpload(response: HttpResponse): UploadedAttachment {
  if (response.status !== 200) throw httpStatusFailure(response.status, 'upload');
  const { status, uploads } = parseUploadAnswer(new TextDecoder().decode(response.body));
  if (status !== 200) throw httpStatusFailure(status, 'upload-servlet');
  const first = uploads[0];
  if (!first) throw new MailError('server', 'upload-empty');
  return first;
}

function readDownload(response: HttpResponse): Uint8Array {
  if (response.status !== 200) throw httpStatusFailure(response.status, 'download');
  return response.body;
}

/** What the API calls through: the session's two seams (a test can stand a token-holder in). */
export type MailCaller = Pick<MailSession, 'call' | 'http'>;

export class MailApi {
  constructor(private readonly session: MailCaller) {}

  /** The signed-in account (`GetInfo`). */
  async account(): Promise<MailAccount> {
    Log.d('MAIL-API', 'account');
    return parseInfo(await this.session.call(getInfoRequest()));
  }

  /** The folder tree, with counts. */
  async folders(): Promise<MailFolder[]> {
    Log.d('MAIL-API', 'folders');
    return parseFolders(await this.session.call(getFolderRequest()));
  }

  /** One page of conversations of a folder (or of a search), newest first. */
  async conversations(options: SearchOptions): Promise<Page<ConversationSummary>> {
    Log.d('MAIL-API', `conversations offset ${options.offset} limit ${options.limit}`);
    const body = await this.session.call(searchRequest('conversation', options));
    return parseConversationPage(body, options.offset);
  }

  /** One page of messages (Drafts and Sent are read by message), newest first. */
  async messages(options: SearchOptions): Promise<Page<MessageSummary>> {
    Log.d('MAIL-API', `messages offset ${options.offset} limit ${options.limit}`);
    const body = await this.session.call(searchRequest('message', options));
    return parseMessagePage(body, options.offset);
  }

  /** A conversation, every message whole, oldest first. */
  async conversation(id: string): Promise<MailConversation> {
    Log.d('MAIL-API', 'conversation');
    return parseConversation(await this.session.call(getConvRequest(id)));
  }

  /** One message, whole. */
  async message(id: string): Promise<MailMessage> {
    Log.d('MAIL-API', 'message');
    return parseMessage(await this.session.call(getMsgRequest(id)));
  }

  /**
   * Applies `op` to every id at once. `folderId` is the destination of `move` (and of `not_spam`);
   * `listedRole` is the role of the folder the conversations were listed from, which decides the
   * messages of a conversation the action leaves where they are ({@link conversationConstraint}).
   * No id, no call.
   */
  async act(
    target: ActionTarget,
    op: MailActionOp,
    ids: readonly string[],
    options: { folderId?: string; listedRole?: string | null } = {}
  ): Promise<void> {
    if (ids.length === 0) {
      Log.d('MAIL-API', `act ${op}: no item, nothing sent`);
      return;
    }
    if (op === 'move' && options.folderId === undefined) {
      throw new MailError('internal', 'move-without-folder');
    }
    Log.d('MAIL-API', `act ${op} on ${ids.length} ${target}(s)`);
    await this.session.call(
      actionRequest(target, op, ids, {
        folderId: options.folderId,
        constraint:
          target === 'conversation'
            ? conversationConstraint(options.listedRole ?? null)
            : undefined,
      })
    );
  }

  /** Sends `message` (and deletes its draft). Resolves with the sent message's id. */
  async send(message: OutgoingMessage): Promise<string> {
    Log.d('MAIL-API', `send (${message.attachments.length} attachment(s))`);
    return parseWrittenMessageId(
      await this.session.call(sendMsgRequest(message)),
      'SendMsgResponse'
    );
  }

  /** Saves `message` as a draft (over its previous save). Resolves with the draft's id. */
  async saveDraft(message: OutgoingMessage): Promise<string> {
    Log.d('MAIL-API', 'save draft');
    return parseWrittenMessageId(
      await this.session.call(saveDraftRequest(message)),
      'SaveDraftResponse'
    );
  }

  /** Uploads a file to attach to the next send or save. */
  async upload(file: FileToUpload): Promise<UploadedAttachment> {
    Log.d('MAIL-API', `upload (${file.bytes.length} bytes)`);
    const contentType = SAFE_CONTENT_TYPE.test(file.contentType)
      ? file.contentType
      : 'application/octet-stream';
    return this.session.http(
      (token) => ({
        method: 'POST',
        path: UPLOAD_PATH,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${uploadFilename(file.filename)}"`,
          Cookie: `ZM_AUTH_TOKEN=${token}`,
        },
        body: file.bytes,
      }),
      readUpload
    );
  }

  /** Downloads one attachment's bytes. */
  async download(ref: Pick<AttachmentRef, 'messageId' | 'part'>): Promise<Uint8Array> {
    Log.d('MAIL-API', 'download');
    const query = `auth=co&id=${encodeURIComponent(ref.messageId)}&part=${encodeURIComponent(ref.part)}`;
    return this.session.http(
      (token) => ({
        method: 'GET',
        path: `/service/home/~/?${query}`,
        headers: { Cookie: `ZM_AUTH_TOKEN=${token}` },
      }),
      readDownload
    );
  }

  /** Addresses matching `text`, the school directory included. Empty text, no call. */
  async directory(text: string): Promise<DirectoryMatch[]> {
    const name = text.trim();
    if (!name) return [];
    Log.d('MAIL-API', 'directory');
    return parseAutoComplete(await this.session.call(autoCompleteRequest(name)));
  }
}
