import { isTauriRuntime } from '$lib/utils/tauriRuntime';
import { Log } from '$lib/utils/Log';
import { mailRelayUrl, relayTransport } from './relayTransport';
import { tauriSocketTransport } from './tauriSocketTransport';
import { connectTls, loadMailTlsEngine } from './tlsConnection';
import type { StreamOpener } from './soapClient';
import type { TransportOpener } from './transport';

/**
 * The transport of this platform (D4): the native socket in a Tauri app, the relay on the web.
 * `apiBase` is the estate's API origin; `token` is the access token for a relay socket that cannot
 * carry the `canari_ws_token` cookie.
 */
export function platformTransport(apiBase: string, token?: string): TransportOpener {
  if (isTauriRuntime()) {
    Log.d('MAIL', 'transport: the native socket');
    return tauriSocketTransport();
  }
  const { url, redacted } = mailRelayUrl(apiBase, token);
  Log.d('MAIL', `transport: the relay at ${redacted}`);
  return relayTransport(url, redacted);
}

/** Opens TLS connections to the mailbox over `transport`, loading the TLS WASM on first use. */
export function mailStreamOpener(transport: TransportOpener): StreamOpener {
  return async () => connectTls(transport, await loadMailTlsEngine());
}
