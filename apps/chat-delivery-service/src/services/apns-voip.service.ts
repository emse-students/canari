import { Injectable, Logger } from '@nestjs/common';
import * as http2 from 'node:http2';
import * as jwt from 'jsonwebtoken';

/**
 * Direct APNs sender for PushKit VoIP pushes (WP-XP-5 incoming-call ring).
 *
 * Why it exists: the whole push stack is FCM-only (iOS alert/background pushes are
 * relayed FCM -> APNs via the .p8 in the Firebase console), but FCM CANNOT carry
 * `apns-push-type: voip` - CallKit rings require a direct APNs HTTP/2 request to the
 * `<bundle-id>.voip` topic. This service is the single, deliberately minimal exception
 * to the all-FCM rule and is used for nothing else.
 *
 * Auth: token-based (JWT ES256 signed with the APNs auth key). Env:
 *  - `APNS_VOIP_KEY_P8`  - .p8 key content (raw PEM, or base64 of the PEM)
 *  - `APNS_VOIP_KEY_ID`  - 10-char key id of the .p8
 *  - `APNS_VOIP_TEAM_ID` - Apple developer team id
 *  - `APNS_VOIP_TOPIC`   - optional, defaults to `fr.emse.canari.voip`
 *  - `APNS_VOIP_SANDBOX` - optional `true` to hit the sandbox gateway
 * All unset -> `isConfigured()` is false and callers skip VoIP delivery (the ring
 * fan-out falls back to a regular FCM alert push for that device).
 */
@Injectable()
export class ApnsVoipService {
  private readonly logger = new Logger(ApnsVoipService.name);

  /** Cached provider JWT - Apple requires reuse between 20 and 60 minutes. */
  private cachedJwt: { token: string; issuedAt: number } | null = null;

  /** True when the three mandatory APNs credentials are present. */
  isConfigured(): boolean {
    return !!(
      process.env.APNS_VOIP_KEY_P8?.trim() &&
      process.env.APNS_VOIP_KEY_ID?.trim() &&
      process.env.APNS_VOIP_TEAM_ID?.trim()
    );
  }

  /** APNs gateway host (sandbox opt-in via APNS_VOIP_SANDBOX=true). */
  private gatewayHost(): string {
    return process.env.APNS_VOIP_SANDBOX === 'true'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com';
  }

  /** VoIP topic: bundle id + `.voip` suffix, overridable for forks. */
  private topic(): string {
    return process.env.APNS_VOIP_TOPIC?.trim() || 'fr.emse.canari.voip';
  }

  /** Decodes APNS_VOIP_KEY_P8 (raw PEM or base64-of-PEM). */
  private privateKeyPem(): string {
    const raw = (process.env.APNS_VOIP_KEY_P8 ?? '').trim();
    if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
    return Buffer.from(raw, 'base64').toString('utf8');
  }

  /**
   * Returns a provider JWT, minting a fresh one when the cached token is older
   * than 40 minutes (Apple rejects tokens older than 1 hour).
   */
  private providerJwt(): string {
    const now = Date.now();
    if (this.cachedJwt && now - this.cachedJwt.issuedAt < 40 * 60 * 1000) {
      return this.cachedJwt.token;
    }
    const token = jwt.sign({}, this.privateKeyPem(), {
      algorithm: 'ES256',
      issuer: process.env.APNS_VOIP_TEAM_ID?.trim(),
      header: { alg: 'ES256', kid: process.env.APNS_VOIP_KEY_ID?.trim() },
    });
    this.cachedJwt = { token, issuedAt: now };
    return token;
  }

  /**
   * Sends one VoIP push. Resolves `true` on APNs 200, `false` otherwise (never throws:
   * ring delivery is best-effort per device). `payload` is the free-form dictionary the
   * PKPushRegistry handler receives; callers include type/groupId/callId/caller info.
   * Returns `"gone"` on APNs 410 (token no longer valid) so the caller can clear it.
   */
  async sendVoipPush(voipToken: string, payload: Record<string, unknown>): Promise<boolean | 'gone'> {
    if (!this.isConfigured()) {
      this.logger.warn('[apns-voip] not configured - skipping VoIP push');
      return false;
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: boolean | 'gone') => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      try {
        const client = http2.connect(this.gatewayHost());
        client.on('error', (e) => {
          this.logger.warn(`[apns-voip] connection error: ${String(e)}`);
          done(false);
        });
        const req = client.request({
          ':method': 'POST',
          ':path': `/3/device/${voipToken}`,
          authorization: `bearer ${this.providerJwt()}`,
          'apns-topic': this.topic(),
          'apns-push-type': 'voip',
          'apns-priority': '10',
          // A ring is pointless after ~45s; let APNs drop it instead of delivering late.
          'apns-expiration': String(Math.floor(Date.now() / 1000) + 45),
          'content-type': 'application/json',
        });
        let status = 0;
        let body = '';
        req.on('response', (headers) => {
          status = Number(headers[':status'] ?? 0);
        });
        req.on('data', (chunk: Buffer | string) => {
          body += String(chunk);
        });
        req.on('end', () => {
          client.close();
          if (status === 200) {
            done(true);
          } else {
            this.logger.warn(`[apns-voip] push failed status=${status} body=${body.slice(0, 200)}`);
            done(status === 410 ? 'gone' : false);
          }
        });
        req.on('error', (e) => {
          this.logger.warn(`[apns-voip] request error: ${String(e)}`);
          client.close();
          done(false);
        });
        req.setTimeout(10_000, () => {
          this.logger.warn('[apns-voip] request timeout');
          req.close(http2.constants.NGHTTP2_CANCEL);
          client.close();
          done(false);
        });
        req.end(JSON.stringify({ aps: {}, ...payload }));
      } catch (e) {
        this.logger.warn(`[apns-voip] send exception: ${String(e)}`);
        done(false);
      }
    });
  }
}
