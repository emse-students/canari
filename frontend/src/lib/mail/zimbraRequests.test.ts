import { describe, expect, it } from 'vitest';
import { emptyMessage } from './mailCompose';
import type { OutgoingMessage } from './mailTypes';
import {
  actionRequest,
  authRequest,
  autoCompleteRequest,
  conversationConstraint,
  endSessionRequest,
  getConvRequest,
  getFolderRequest,
  getInfoRequest,
  getMsgRequest,
  saveDraftRequest,
  searchQuery,
  searchRequest,
  sendMsgRequest,
} from './zimbraRequests';

/** Every SOAP request the client sends, in the shape measured on partage.emse.fr. */

describe('session requests', () => {
  it('AuthRequest names the account by name and carries the password', () => {
    expect(authRequest('a@emse.fr', 'pw')).toEqual({
      AuthRequest: {
        _jsns: 'urn:zimbraAccount',
        account: { by: 'name', _content: 'a@emse.fr' },
        password: { _content: 'pw' },
      },
    });
  });

  it('EndSession, GetInfo and GetFolder', () => {
    expect(endSessionRequest()).toEqual({
      EndSessionRequest: { _jsns: 'urn:zimbraAccount', logoff: '1' },
    });
    expect(getInfoRequest()).toEqual({
      GetInfoRequest: { _jsns: 'urn:zimbraAccount', sections: 'mbox,attrs' },
    });
    expect(getFolderRequest()).toEqual({ GetFolderRequest: { _jsns: 'urn:zimbraMail' } });
  });
});

describe('search', () => {
  it('lists a folder by id, the reader query in parentheses', () => {
    expect(searchQuery({ folderId: '2', query: '' })).toBe('inid:"2"');
    expect(searchQuery({ folderId: '2', query: ' from:bob or exam ' })).toBe(
      'inid:"2" (from:bob or exam)'
    );
    expect(searchQuery({ folderId: null, query: 'exam' })).toBe('(exam)');
    expect(searchQuery({ folderId: null, query: '' })).toBe('is:anywhere');
    expect(searchQuery({ folderId: '2"x', query: '' })).toBe('inid:"2x"');
  });

  it('SearchRequest pages newest first, by conversation or by message', () => {
    expect(
      searchRequest('conversation', { folderId: '2', query: '', offset: 50, limit: 25 })
    ).toEqual({
      SearchRequest: {
        _jsns: 'urn:zimbraMail',
        query: 'inid:"2"',
        types: 'conversation',
        sortBy: 'dateDesc',
        offset: 50,
        limit: 25,
      },
    });
    expect(
      (
        searchRequest('message', { folderId: '6', query: '', offset: 0, limit: 10 })
          .SearchRequest as {
          types: string;
        }
      ).types
    ).toBe('message');
  });

  it('GetConv fetches every message, GetMsg one, both with their HTML', () => {
    expect(getConvRequest('-12')).toEqual({
      GetConvRequest: { _jsns: 'urn:zimbraMail', c: { id: '-12', fetch: 'all', html: 1 } },
    });
    expect(getMsgRequest('12')).toEqual({
      GetMsgRequest: { _jsns: 'urn:zimbraMail', m: { id: '12', html: 1 } },
    });
  });

  it('AutoComplete includes the directory', () => {
    expect(autoCompleteRequest('ada')).toEqual({
      AutoCompleteRequest: { _jsns: 'urn:zimbraMail', name: 'ada', includeGal: 1 },
    });
  });
});

describe('actions', () => {
  it('one MsgAction for many ids, each op mapped', () => {
    const ops = {
      read: 'read',
      unread: '!read',
      flag: 'flag',
      unflag: '!flag',
      trash: 'trash',
      spam: 'spam',
      not_spam: '!spam',
      delete: 'delete',
    } as const;
    for (const [op, zimbra] of Object.entries(ops)) {
      expect(actionRequest('message', op as keyof typeof ops, ['1', '2', '3'])).toEqual({
        MsgActionRequest: { _jsns: 'urn:zimbraMail', action: { op: zimbra, id: '1,2,3' } },
      });
    }
  });

  it('a move names its folder; a conversation action carries its target constraint', () => {
    expect(
      actionRequest('conversation', 'move', ['-1', '7'], { folderId: '257', constraint: '-tjsd' })
    ).toEqual({
      ConvActionRequest: {
        _jsns: 'urn:zimbraMail',
        action: { op: 'move', id: '-1,7', l: '257', tcon: '-tjsd' },
      },
    });
    // A message action has no constraint, whatever is passed.
    expect(actionRequest('message', 'trash', ['1'], { constraint: '-t' })).toEqual({
      MsgActionRequest: { _jsns: 'urn:zimbraMail', action: { op: 'trash', id: '1' } },
    });
  });

  it('the constraint leaves trash, junk, sent and drafts alone, except the folder listed', () => {
    expect(conversationConstraint('inbox')).toBe('-tjsd');
    expect(conversationConstraint(null)).toBe('-tjsd');
    expect(conversationConstraint('trash')).toBe('-jsd');
    expect(conversationConstraint('sent')).toBe('-tjd');
  });
});

describe('SendMsg and SaveDraft', () => {
  const base: OutgoingMessage = {
    ...emptyMessage(),
    to: [{ address: 'a@emse.fr', name: 'Ada' }],
    cc: [{ address: 'b@emse.fr', name: null }],
    bcc: [{ address: 'c@emse.fr', name: null }],
    subject: 'Hello é',
    text: 'body',
  };

  it('a plain message: recipients by type, the subject, one text part', () => {
    expect(sendMsgRequest(base)).toEqual({
      SendMsgRequest: {
        _jsns: 'urn:zimbraMail',
        m: {
          e: [
            { t: 't', a: 'a@emse.fr', p: 'Ada' },
            { t: 'c', a: 'b@emse.fr' },
            { t: 'b', a: 'c@emse.fr' },
          ],
          su: { _content: 'Hello é' },
          mp: [{ ct: 'text/plain', content: { _content: 'body' } }],
        },
      },
    });
  });

  it('HTML goes beside the text, as multipart/alternative', () => {
    const m = (
      sendMsgRequest({ ...base, html: '<p>body</p>' }).SendMsgRequest as { m: { mp: unknown } }
    ).m;
    expect(m.mp).toEqual([
      {
        ct: 'multipart/alternative',
        mp: [
          { ct: 'text/plain', content: { _content: 'body' } },
          { ct: 'text/html', content: { _content: '<p>body</p>' } },
        ],
      },
    ]);
  });

  it('a reply with uploads, forwarded parts and its draft', () => {
    const message: OutgoingMessage = {
      ...base,
      attachments: [
        { uploadId: 'u1', filename: 'a', contentType: 'x/y', size: 1 },
        { uploadId: 'u2', filename: 'b', contentType: 'x/y', size: 1 },
      ],
      forwardedParts: [{ messageId: '40', part: '2' }],
      origin: { kind: 'reply', messageId: '40', messageIdHeader: '<abc@x>' },
      draftId: '99',
    };
    const sent = (sendMsgRequest(message).SendMsgRequest as { m: Record<string, unknown> }).m;
    expect(sent.attach).toEqual({ aid: 'u1,u2', mp: [{ mid: '40', part: '2' }] });
    expect(sent.origid).toBe('40');
    expect(sent.rt).toBe('r');
    expect(sent.irt).toEqual({ _content: '<abc@x>' });
    expect(sent.did).toBe('99');
    expect(sent.id).toBeUndefined();

    const saved = (saveDraftRequest(message).SaveDraftRequest as { m: Record<string, unknown> }).m;
    expect(saved.id).toBe('99');
    expect(saved.did).toBeUndefined();
    const forward = sendMsgRequest({
      ...message,
      origin: { kind: 'forward', messageId: '40', messageIdHeader: null },
    }).SendMsgRequest as { m: Record<string, unknown> };
    expect(forward.m.rt).toBe('w');
    expect(forward.m.irt).toBeUndefined();
  });
});
