// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeZimbra, zimbraBody, zimbraFault, type FakeZimbraAnswer } from '../../test/mailFakes';
import { MailApi, uploadFilename } from './mailApi';
import { MailSession } from './mailSession';
import { emptyMessage } from './mailCompose';
import { ZimbraSoapClient } from './soapClient';

/**
 * The mailbox API over a signed-in session: bulk actions are ONE call, attachments go up and down
 * on the same connection as the SOAP calls, carrying the session cookie, and a lapsed session is
 * renewed for them too.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const ADDRESS = 'ada@etu.emse.fr';

let expired = false;

function setup(other: (r: FakeZimbra['requests'][number]) => FakeZimbraAnswer | null = () => null) {
  let issued = 0;
  const zimbra = new FakeZimbra((r) => {
    if (r.soap?.name === 'AuthRequest') {
      expired = false;
      return zimbraBody({ AuthResponse: { authToken: [{ _content: `t${++issued}` }] } });
    }
    if (r.soap?.name === 'GetInfoRequest')
      return zimbraBody({ GetInfoResponse: { name: ADDRESS } });
    const answer = other(r);
    if (answer) return answer;
    return zimbraBody({ [`${r.soap?.name.replace('Request', 'Response')}`]: {} });
  });
  const session = new MailSession(new ZimbraSoapClient(zimbra.openStream), {
    userId: 'u',
    deviceKey: () => KEY,
    mailAddress: async () => ADDRESS,
  });
  return { zimbra, session, api: new MailApi(session) };
}

beforeEach(() => {
  localStorage.clear();
  expired = false;
});

describe('MailApi actions', () => {
  it('a bulk action is ONE call for every id, with the constraint of the folder listed', async () => {
    const { zimbra, session, api } = setup();
    await session.signIn('pw', false);
    await api.act('conversation', 'trash', ['-1', '-2', '-3'], { listedRole: 'inbox' });
    await api.act('message', 'move', ['4', '5'], { folderId: '300' });
    const actions = zimbra.requests.filter((r) => r.soap?.name.endsWith('ActionRequest'));
    expect(actions.map((r) => [r.soap!.name, r.soap!.element.action])).toEqual([
      ['ConvActionRequest', { op: 'trash', id: '-1,-2,-3', tcon: '-tjsd' }],
      ['MsgActionRequest', { op: 'move', id: '4,5', l: '300' }],
    ]);
  });

  it('no id, no call; a move with no folder is refused before sending', async () => {
    const { zimbra, session, api } = setup();
    await session.signIn('pw', false);
    const before = zimbra.requests.length;
    await api.act('conversation', 'read', []);
    await expect(api.act('message', 'move', ['1'])).rejects.toMatchObject({ kind: 'internal' });
    expect(zimbra.requests.length).toBe(before);
  });

  it('a not-found fault is typed', async () => {
    const { session, api } = setup((r) =>
      r.soap?.name === 'GetMsgRequest' ? zimbraFault('mail.NO_SUCH_MSG') : null
    );
    await session.signIn('pw', false);
    await expect(api.message('9')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('send and save draft answer the written id', async () => {
    const { session, api } = setup((r) =>
      r.soap?.name === 'SendMsgRequest'
        ? zimbraBody({ SendMsgResponse: { m: [{ id: '101' }] } })
        : r.soap?.name === 'SaveDraftRequest'
          ? zimbraBody({ SaveDraftResponse: { m: [{ id: '55' }] } })
          : null
    );
    await session.signIn('pw', false);
    const message = { ...emptyMessage(), to: [{ address: 'b@emse.fr', name: null }], text: 'x' };
    expect(await api.saveDraft(message)).toBe('55');
    expect(await api.send({ ...message, draftId: '55' })).toBe('101');
  });

  it('an empty directory query sends nothing', async () => {
    const { zimbra, session, api } = setup();
    await session.signIn('pw', false);
    const before = zimbra.requests.length;
    expect(await api.directory('  ')).toEqual([]);
    expect(zimbra.requests.length).toBe(before);
  });
});

describe('MailApi attachments', () => {
  it('uploads on the SAME connection, with the session cookie and an encoded filename', async () => {
    const { zimbra, session, api } = setup((r) =>
      r.path.startsWith('/service/upload')
        ? {
            body: `200,'null',[{"aid":"up-1","ct":"application/pdf","filename":"cours é.pdf","s":3}]`,
          }
        : null
    );
    await session.signIn('pw', false);
    const uploaded = await api.upload({
      filename: 'cours é.pdf',
      contentType: 'application/pdf',
      bytes: new TextEncoder().encode('pdf'),
    });
    expect(uploaded).toEqual({
      uploadId: 'up-1',
      filename: 'cours é.pdf',
      contentType: 'application/pdf',
      size: 3,
    });
    const upload = zimbra.requests.at(-1)!;
    expect(upload.method).toBe('POST');
    expect(upload.path).toBe('/service/upload?fmt=raw,extended');
    expect(upload.headers.cookie).toBe('ZM_AUTH_TOKEN=t1');
    expect(upload.headers['content-disposition']).toBe('attachment; filename="cours &#233;.pdf"');
    expect(upload.body).toBe('pdf');
    expect(zimbra.streams).toHaveLength(1);
  });

  it('a content type that is not one is sent as octets; a refused upload is typed', async () => {
    const { zimbra, session, api } = setup((r) =>
      r.path.startsWith('/service/upload') ? { body: `413,'null'` } : null
    );
    await session.signIn('pw', false);
    await expect(
      api.upload({ filename: 'a', contentType: 'text/plain\r\nX: y', bytes: new Uint8Array(1) })
    ).rejects.toMatchObject({ kind: 'too_large' });
    expect(zimbra.requests.at(-1)!.headers['content-type']).toBe('application/octet-stream');
  });

  it('downloads a part, and renews the session once when the download is refused 401', async () => {
    await import('./sealedMailPassword').then((m) =>
      m.rememberMailPassword('u', KEY, { account: ADDRESS, password: 'pw' })
    );
    const { zimbra, session, api } = setup((r) => {
      if (!r.path.startsWith('/service/home/')) return null;
      return expired ? { status: 401, body: '' } : { body: 'BYTES' };
    });
    await session.signIn('pw', true);
    expired = true;
    const bytes = await api.download({ messageId: '40', part: '2.1' });
    expect(new TextDecoder().decode(bytes)).toBe('BYTES');
    const downloads = zimbra.requests.filter((r) => r.path.startsWith('/service/home/'));
    expect(downloads.map((r) => [r.method, r.path, r.headers.cookie])).toEqual([
      ['GET', '/service/home/~/?auth=co&id=40&part=2.1', 'ZM_AUTH_TOKEN=t1'],
      ['GET', '/service/home/~/?auth=co&id=40&part=2.1', 'ZM_AUTH_TOKEN=t2'],
    ]);
  });

  it('uploadFilename turns everything outside printable ASCII, quotes and ampersands into entities', () => {
    expect(uploadFilename('a"b&c\r\nd€.txt')).toBe('a&#34;b&#38;c&#13;&#10;d&#8364;.txt');
  });
});
