import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MailApi, type MailCaller } from './mailApi';
import { emptyMessage } from './mailCompose';
import { relayTransport } from './relayTransport';
import { MAIL_HOST, ZimbraSoapClient } from './soapClient';
import { connectTls } from './tlsConnection';
import { searchRequest } from './zimbraRequests';
import { MailTransportError, type TransportOpener } from './transport';

/**
 * THE ZIMBRA CLIENT AGAINST THE REAL MAILBOX, OPT-IN (docs/wiki/mail-client-transport.md#the-end-to-end-test-of-lot-2).
 *
 * Skipped unless `CANARI_MAIL_TEST_TOKEN_FILE` names a JSON file `{ "authToken", "account" }` holding
 * a session token of the test account (never a password, never committed, never printed). It reads
 * the account (`GetInfo`), the folders (`GetFolder`), a search limited to earlier test mails, and
 * one search of 500 messages whose answer exceeds 64 KiB, of which ONLY the count and the size are
 * read - no real mail's content is read. With `CANARI_MAIL_TEST_SEND=1` it also uploads a small attachment and
 * sends ONE mail to the account ITSELF, subject prefixed `[test Canari]`, then reads that mail back
 * and downloads its attachment.
 *
 * The transport is the relay when `CANARI_MAIL_E2E_RELAY` names one (lot 1's test), otherwise a
 * plain TCP socket from this test process to partage.emse.fr:443 - the stand-in, in a test, for the
 * apps' native socket: the TLS is still the WASM's. Needs `bun run wasm:build` first.
 */
const tokenFile = process.env.CANARI_MAIL_TEST_TOKEN_FILE;
const send = process.env.CANARI_MAIL_TEST_SEND === '1';
const relayUrl = process.env.CANARI_MAIL_E2E_RELAY;

/** A TCP socket to the mailbox, from the test process. */
function directSocket(): TransportOpener {
  return (handlers) =>
    new Promise((resolveOpen, rejectOpen) => {
      const socket = connect(443, MAIL_HOST);
      let opened = false;
      let ended = false;
      const end = (how: Parameters<typeof handlers.onEnd>[0]) => {
        if (ended) return;
        ended = true;
        handlers.onEnd(how);
      };
      socket.on('data', (chunk: Buffer) => handlers.onBytes(new Uint8Array(chunk)));
      socket.on('close', () => end({ kind: 'peer_closed' }));
      socket.on('error', (err) => {
        if (!opened) rejectOpen(new MailTransportError('unreachable', String(err)));
        else end({ kind: 'failed', detail: String(err) });
      });
      socket.once('connect', () => {
        opened = true;
        resolveOpen({
          send: (bytes) =>
            new Promise((done, fail) => {
              if (ended) return fail(new MailTransportError('closed', 'the socket ended'));
              socket.write(bytes, (err) =>
                err ? fail(new MailTransportError('closed', String(err))) : done()
              );
            }),
          close: () => {
            socket.destroy();
            end({ kind: 'closed_by_us' });
          },
        });
      });
    });
}

describe.skipIf(!tokenFile)('the Zimbra client end to end (opt-in)', () => {
  it('reads the account, the folders and a search; sends to itself only when asked', async () => {
    const { authToken, account } = JSON.parse(readFileSync(tokenFile!, 'utf8')) as {
      authToken: string;
      account: string;
    };
    const bindings = await import('$lib/wasm/mail-tls/mail_tls.js');
    bindings.initSync({
      module: readFileSync(resolve(import.meta.dirname, '../wasm/mail-tls/mail_tls_bg.wasm')),
    });
    const transport = relayUrl ? relayTransport(relayUrl, 'the e2e relay') : directSocket();
    const soap = new ZimbraSoapClient(() =>
      connectTls(transport, () => new bindings.MailTlsClient())
    );
    // The token stands in for the session: the API is exercised exactly as the session drives it.
    const caller: MailCaller = {
      call: (body) => soap.call(body, authToken),
      http: async (build, read) => read(await soap.exchange(build(authToken))),
    };
    const api = new MailApi(caller);
    try {
      const me = await api.account();
      expect(me.address.toLowerCase()).toBe(account.toLowerCase());

      const folders = await api.folders();
      const inbox = folders.find((f) => f.role === 'inbox');
      expect(inbox).toBeDefined();
      expect(folders.some((f) => f.role === 'sent')).toBe(true);

      const page = await api.conversations({
        folderId: inbox!.id,
        query: 'subject:"[test Canari]"',
        offset: 0,
        limit: 5,
      });
      expect(Array.isArray(page.items)).toBe(true);
      for (const c of page.items) expect(c.subject).toContain('[test Canari]');

      // An answer over 64 KiB, on the real server: lot 1's TLS and HTTP framing carry it whole.
      // ONLY its count and its size are read - no subject, sender or body of a real mail.
      const large = await soap.call(
        searchRequest('message', { folderId: null, query: '', offset: 0, limit: 500 }),
        authToken
      );
      const messages = (large.SearchResponse as { m?: unknown[] } | undefined)?.m ?? [];
      const answerBytes = new TextEncoder().encode(JSON.stringify(large)).length;
      console.info(`[e2e] large search: ${messages.length} message(s), ${answerBytes} bytes`);
      expect(messages.length).toBeGreaterThan(0);
      expect(answerBytes).toBeGreaterThan(64 * 1024);

      if (!send) return;
      const filename = 'canari-test-é.txt';
      const uploaded = await api.upload({
        filename,
        contentType: 'text/plain',
        bytes: new TextEncoder().encode('lot 2 attachment'),
      });
      expect(uploaded.filename).toBe(filename);
      const sentId = await api.send({
        ...emptyMessage(),
        to: [{ address: me.address, name: null }],
        subject: `[test Canari] lot 2 ${new Date().toISOString()}`,
        text: 'Envoyé par le test de bout en bout du lot 2 (accents : é à ç).',
        html: '<p>Envoyé par le test de bout en bout du lot 2 (accents : é à ç).</p>',
        attachments: [uploaded],
      });
      const sent = await api.message(sentId);
      expect(sent.subject.startsWith('[test Canari]')).toBe(true);
      const part = sent.attachments.find((a) => a.filename === filename);
      expect(part).toBeDefined();
      const bytes = await api.download(part!);
      expect(new TextDecoder().decode(bytes)).toBe('lot 2 attachment');
    } finally {
      soap.close();
    }
  }, 60_000);
});
