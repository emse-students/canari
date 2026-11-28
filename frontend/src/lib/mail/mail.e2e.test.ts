import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { relayTransport } from './relayTransport';
import { ZimbraSoapClient } from './soapClient';
import { connectTls } from './tlsConnection';

/**
 * THE WHOLE PATH AGAINST THE REAL MAILBOX, OPT-IN (docs/wiki/mail-client-transport.md#the-end-to-end-test).
 *
 * Skipped unless `CANARI_MAIL_E2E_RELAY` names a running relay's full WebSocket URL, token included
 * (`ws://127.0.0.1:<port>/api/mail/relay?token=<jwt>`). It sends ONE unauthenticated `GetInfo`
 * through the relay, the WASM TLS and the HTTP/1.1 client, and expects Zimbra's
 * `service.AUTH_REQUIRED` fault: proof that the bytes reached partage.emse.fr and came back, with no
 * credential anywhere. It needs `bun run wasm:build` first.
 */
const relayUrl = process.env.CANARI_MAIL_E2E_RELAY;

describe.skipIf(!relayUrl)('mail transport end to end (opt-in)', () => {
  it('an unauthenticated GetInfo answers service.AUTH_REQUIRED, twice on one connection', async () => {
    const bindings = await import('$lib/wasm/mail-tls/mail_tls.js');
    bindings.initSync({
      module: readFileSync(resolve(import.meta.dirname, '../wasm/mail-tls/mail_tls_bg.wasm')),
    });
    let opened = 0;
    const soap = new ZimbraSoapClient(() => {
      opened++;
      return connectTls(
        relayTransport(relayUrl!, 'the e2e relay'),
        () => new bindings.MailTlsClient()
      );
    });
    try {
      for (let i = 0; i < 2; i++) {
        await expect(
          soap.call({ GetInfoRequest: { _jsns: 'urn:zimbraAccount' } })
        ).rejects.toMatchObject({
          name: 'ZimbraFault',
          code: 'service.AUTH_REQUIRED',
          status: 500,
        });
      }
      expect(opened).toBe(1);
    } finally {
      soap.close();
    }
  }, 30_000);
});
