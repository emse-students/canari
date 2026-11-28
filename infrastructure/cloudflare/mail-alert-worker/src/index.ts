/**
 * Canari's mail alert relay, a Cloudflare Email Worker (mail lot 5,
 * docs/wiki/mail-client-transport.md#as-built---lot-5). Email Routing hands it every message sent
 * to the alert domain; it reads the envelope recipient ONLY (`relayAlert`) and drops the message.
 */
import { relayAlert, type AlertEnv } from './alert';

/** The part of Cloudflare's `ForwardableEmailMessage` this Worker touches: the recipient, no more. */
interface IncomingAlert {
  readonly to: string;
}

export default {
  async email(message: IncomingAlert, env: AlertEnv): Promise<void> {
    const outcome = await relayAlert(message.to, env);
    console.log(`[mail-alert] ${outcome}`);
  },
};
