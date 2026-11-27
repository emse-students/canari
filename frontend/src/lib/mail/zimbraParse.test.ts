import { describe, expect, it } from 'vitest';
import { MailError } from './mailErrors';
import {
  flattenFolders,
  parseAuth,
  parseAutoComplete,
  parseConversation,
  parseConversationPage,
  parseFlags,
  parseFolders,
  parseInfo,
  parseMailbox,
  parseMessage,
  parseMessagePage,
  parseUploadAnswer,
  parseWrittenMessageId,
} from './zimbraParse';

/** Zimbra's answers (shapes as partage.emse.fr sends them), read into the domain types. */

describe('session answers', () => {
  it('AuthResponse: the token, as an array or an object', () => {
    expect(parseAuth({ AuthResponse: { authToken: [{ _content: 't' }], lifetime: 1 } })).toEqual({
      token: 't',
    });
    expect(parseAuth({ AuthResponse: { authToken: { _content: 't2' } } })).toEqual({ token: 't2' });
  });

  it('an answer without what the call is for is a typed server failure', () => {
    expect(() => parseAuth({ AuthResponse: {} })).toThrow(MailError);
    expect(() => parseAuth({})).toThrow(MailError);
    try {
      parseInfo({ GetInfoResponse: {} });
    } catch (err) {
      expect(err).toMatchObject({ kind: 'server' });
    }
  });

  it('GetInfoResponse: the canonical address and the display name', () => {
    expect(
      parseInfo({ GetInfoResponse: { name: 'a@emse.fr', attrs: { _attrs: { displayName: 'A' } } } })
    ).toEqual({ address: 'a@emse.fr', displayName: 'A' });
    expect(parseInfo({ GetInfoResponse: { name: 'a@emse.fr' } }).displayName).toBeNull();
  });
});

describe('parseFolders', () => {
  const answer = {
    GetFolderResponse: {
      folder: [
        {
          id: '1',
          name: 'USER_ROOT',
          folder: [
            {
              id: '2',
              name: 'Inbox',
              absFolderPath: '/Inbox',
              n: 40,
              u: 3,
              view: 'message',
              folder: [{ id: '300', name: 'School', absFolderPath: '/Inbox/School', n: 2 }],
            },
            { id: '5', name: 'Sent', absFolderPath: '/Sent', n: 10, view: 'message' },
            { id: '10', name: 'Calendar', view: 'appointment', n: 4 },
            { id: '7', name: 'Contacts', view: 'contact' },
            { id: '3', name: 'Trash', absFolderPath: '/Trash' },
          ],
        },
      ],
    },
  };

  it('keeps mail folders, with roles, counts (u absent is 0) and children', () => {
    const folders = parseFolders(answer);
    expect(folders.map((f) => f.id)).toEqual(['2', '5', '3']);
    expect(folders[0]).toMatchObject({ role: 'inbox', total: 40, unread: 3, parentId: null });
    expect(folders[0].children[0]).toMatchObject({
      id: '300',
      path: '/Inbox/School',
      parentId: '2',
      role: null,
      unread: 0,
    });
    expect(folders[2]).toMatchObject({ role: 'trash', total: 0, unread: 0 });
    expect(flattenFolders(folders).map((f) => f.id)).toEqual(['2', '300', '5', '3']);
  });
});

describe('lists', () => {
  it('parseFlags reads every letter it knows', () => {
    expect(parseFlags('ufarwd')).toEqual({
      unread: true,
      flagged: true,
      attachment: true,
      replied: true,
      forwarded: true,
      draft: true,
    });
    expect(parseFlags(undefined).unread).toBe(false);
  });

  it('a conversation page, with its senders and whether more follow', () => {
    const page = parseConversationPage(
      {
        SearchResponse: {
          more: true,
          c: [
            {
              id: '-5',
              su: 'Exam',
              fr: 'The exam is...',
              d: 1700000000000,
              n: 3,
              u: 1,
              f: 'ua',
              e: [
                { t: 'f', a: 'prof@emse.fr', p: 'Prof' },
                { t: 'f', a: 'me@etu.emse.fr' },
              ],
            },
          ],
        },
      },
      50
    );
    expect(page).toEqual({
      offset: 50,
      hasMore: true,
      items: [
        {
          id: '-5',
          subject: 'Exam',
          fragment: 'The exam is...',
          date: 1700000000000,
          messageCount: 3,
          unreadCount: 1,
          senders: [
            { address: 'prof@emse.fr', name: 'Prof' },
            { address: 'me@etu.emse.fr', name: null },
          ],
          flags: parseFlags('ua'),
        },
      ],
    });
    expect(parseConversationPage({ SearchResponse: {} }, 0)).toEqual({
      items: [],
      offset: 0,
      hasMore: false,
    });
  });

  it('a message page', () => {
    const page = parseMessagePage(
      {
        SearchResponse: {
          m: [
            {
              id: '9',
              cid: '-9',
              l: '6',
              su: 'Draft',
              d: 5,
              f: 'd',
              e: [{ t: 't', a: 'x@emse.fr' }],
            },
          ],
        },
      },
      0
    );
    expect(page.items[0]).toMatchObject({
      id: '9',
      conversationId: '-9',
      folderId: '6',
      from: null,
      to: [{ address: 'x@emse.fr', name: null }],
      flags: { draft: true },
    });
  });
});

describe('messages', () => {
  const raw = {
    id: '40',
    cid: '-40',
    l: '2',
    d: 1000,
    su: 'Hi',
    fr: 'frag',
    f: 'a',
    mid: '<abc@x>',
    e: [
      { t: 'f', a: 'from@emse.fr', p: 'From' },
      { t: 't', a: 'to@emse.fr' },
      { t: 'c', a: 'cc@emse.fr' },
      { t: 'r', a: 'reply@emse.fr' },
    ],
    mp: [
      {
        part: 'TEXT',
        ct: 'multipart/mixed',
        mp: [
          {
            part: '1',
            ct: 'multipart/alternative',
            mp: [
              { part: '1.1', ct: 'text/plain', s: 4, content: 'text' },
              { part: '1.2', ct: 'text/html', s: 11, body: true, content: '<p>html</p>' },
            ],
          },
          { part: '2', ct: 'application/pdf', s: 1234, cd: 'attachment', filename: 'cours.pdf' },
          { part: '3', ct: 'image/png', s: 99, cd: 'inline', filename: 'logo.png', ci: '<logo@x>' },
        ],
      },
    ],
  };

  it('GetMsg: addresses by type, the bodies, the attachments and inline images', () => {
    const message = parseMessage({ GetMsgResponse: { m: [raw] } });
    expect(message).toMatchObject({
      id: '40',
      conversationId: '-40',
      folderId: '2',
      from: { address: 'from@emse.fr', name: 'From' },
      to: [{ address: 'to@emse.fr', name: null }],
      cc: [{ address: 'cc@emse.fr', name: null }],
      replyTo: [{ address: 'reply@emse.fr', name: null }],
      messageIdHeader: '<abc@x>',
      html: '<p>html</p>',
      text: 'text',
    });
    expect(message.attachments).toEqual([
      {
        messageId: '40',
        part: '2',
        filename: 'cours.pdf',
        contentType: 'application/pdf',
        size: 1234,
        contentId: null,
        inline: false,
      },
      {
        messageId: '40',
        part: '3',
        filename: 'logo.png',
        contentType: 'image/png',
        size: 99,
        contentId: 'logo@x',
        inline: true,
      },
    ]);
  });

  it('GetConv: the messages oldest first', () => {
    const conversation = parseConversation({
      GetConvResponse: {
        c: [{ id: '-40', su: 'Hi', m: [{ ...raw, id: '41', d: 2000 }, raw] }],
      },
    });
    expect(conversation.id).toBe('-40');
    expect(conversation.messages.map((m) => m.id)).toEqual(['40', '41']);
  });

  it('SendMsg / SaveDraft: the id written, or a typed failure', () => {
    expect(
      parseWrittenMessageId({ SendMsgResponse: { m: [{ id: '77' }] } }, 'SendMsgResponse')
    ).toBe('77');
    expect(() => parseWrittenMessageId({ SaveDraftResponse: {} }, 'SaveDraftResponse')).toThrow(
      MailError
    );
  });
});

describe('directory and uploads', () => {
  it('parseMailbox reads the three forms the autocomplete writes', () => {
    expect(parseMailbox('"Lovelace, Ada" <ada@emse.fr>')).toEqual({
      address: 'ada@emse.fr',
      name: 'Lovelace, Ada',
    });
    expect(parseMailbox('Ada <ada@emse.fr>')).toEqual({ address: 'ada@emse.fr', name: 'Ada' });
    expect(parseMailbox('ada@emse.fr')).toEqual({ address: 'ada@emse.fr', name: null });
    expect(parseMailbox('not an address')).toBeNull();
  });

  it('AutoComplete: one suggestion per address, by source', () => {
    expect(
      parseAutoComplete({
        AutoCompleteResponse: {
          match: [
            { email: '"Ada" <ada@emse.fr>', type: 'gal' },
            { email: 'bob@etu.emse.fr', type: 'rankingTable' },
            { email: 'Carol <carol@x.fr>', type: 'contact' },
            { type: 'gal' },
          ],
        },
      })
    ).toEqual([
      { address: 'ada@emse.fr', name: 'Ada', source: 'directory' },
      { address: 'bob@etu.emse.fr', name: null, source: 'recent' },
      { address: 'carol@x.fr', name: 'Carol', source: 'contact' },
    ]);
  });

  it("the upload servlet's raw,extended answer", () => {
    expect(
      parseUploadAnswer(
        `200,'null',[{"aid":"a1:b2","ct":"application/pdf","filename":"c.pdf","s":12}]`
      )
    ).toEqual({
      status: 200,
      uploads: [{ uploadId: 'a1:b2', filename: 'c.pdf', contentType: 'application/pdf', size: 12 }],
    });
    expect(parseUploadAnswer(`413,'null'`)).toEqual({ status: 413, uploads: [] });
    expect(() => parseUploadAnswer('<html>')).toThrow(MailError);
    expect(() => parseUploadAnswer(`200,'null',not json`)).toThrow(MailError);
  });
});
