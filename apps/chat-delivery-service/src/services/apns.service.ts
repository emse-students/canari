import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as http2 from 'http2';
import { ApnsRequest } from './push-payload';

/** Resolved APNs provider configuration (all required fields present). */
interface ApnsConfig {
  /** Provider auth key (.p8 PEM, EC P-256). May contain literal `\n`. */
  authKey: string;
  /** Key ID of the auth key (Apple Developer portal). */
  keyId: string;
  /** Apple Developer Team ID. */
  teamId: string;
  /** App bundle identifier, used as the `apns-topic`. */
  bundleId: string;
  /** Production gateway when true, sandbox otherwise. */
  production: boolean;
}

/** Outcome of an APNs send attempt. */
export interface ApnsSendResult {
  /** True when APNs is not configured: nothing was sent (inert no-op). */
  skipped: boolean;
  /** HTTP/2 `:status` returned by APNs (0 on transport failure). */
  status?: number;
  /** APNs `reason` string on rejection, if any. */
  reason?: string;
  /** True when the device token is permanently invalid and should be deleted. */
  terminal?: boolean;
}

const PROVIDER_TOKEN_TTL_SECONDS = 50 * 60; // Apple requires refresh within 20-60 min.
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Sends push notifications to Apple devices via the APNs HTTP/2 provider API
 * using token-based (.p8) authentication.
 *
 * Inert by design: when `APNS_AUTH_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` are not
 * set (the default today), {@link isConfigured} is false and every send is a
 * logged no-op. This lets the iOS push path be wired ahead of the iOS client
 * without affecting production, mirroring how Firebase is gated on
 * `FIREBASE_SERVICE_ACCOUNT_JSON`.
 *
 * No third-party dependency: the provider JWT is signed with Node's `crypto`
 * (ES256) and delivery uses the built-in `http2` client.
 */
@Injectable()
export class ApnsService {
  private readonly logger = new Logger(ApnsService.name);

  /** Cached provider JWT, refreshed before {@link PROVIDER_TOKEN_TTL_SECONDS}. */
  private cachedJwt: { token: string; iat: number; keyId: string } | null = null;

  /** Cached parsed private key, keyed by the normalised PEM to avoid re-parsing. */
  private cachedKey: { pem: string; key: crypto.KeyObject } | null = null;

  /** Reads APNs config from the environment, or null when not fully configured. */
  private getConfig(): ApnsConfig | null {
    const authKey = process.env.APNS_AUTH_KEY;
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID;
    if (!authKey || !keyId || !teamId) return null;
    return {
      authKey,
      keyId,
      teamId,
      bundleId: process.env.APNS_BUNDLE_ID || 'fr.emse.canari',
      production: process.env.APNS_PRODUCTION === 'true',
    };
  }

  /** Whether APNs is configured. When false, all sends are inert no-ops. */
  isConfigured(): boolean {
    return this.getConfig() !== null;
  }

  /** Parses (and caches) the EC private key from the .p8 PEM, normalising `\n`. */
  private getPrivateKey(authKeyRaw: string): crypto.KeyObject {
    const pem = authKeyRaw.replace(/\\n/g, '\n');
    if (this.cachedKey && this.cachedKey.pem === pem) return this.cachedKey.key;
    const key = crypto.createPrivateKey(pem);
    this.cachedKey = { pem, key };
    return key;
  }

  /**
   * Returns the cached provider JWT (the value of the `authorization` header),
   * or null when APNs is not configured. Signed with ES256 over the .p8 key.
   */
  getProviderToken(): string | null {
    const cfg = this.getConfig();
    if (!cfg) return null;

    const now = Math.floor(Date.now() / 1000);
    if (
      this.cachedJwt &&
      this.cachedJwt.keyId === cfg.keyId &&
      now - this.cachedJwt.iat < PROVIDER_TOKEN_TTL_SECONDS
    ) {
      return this.cachedJwt.token;
    }

    const enc = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const signingInput = `${enc({ alg: 'ES256', kid: cfg.keyId })}.${enc({
      iss: cfg.teamId,
      iat: now,
    })}`;
    // dsaEncoding 'ieee-p1363' yields the raw r||s signature JWT expects (not DER).
    const signature = crypto
      .sign('SHA256', Buffer.from(signingInput), {
        key: this.getPrivateKey(cfg.authKey),
        dsaEncoding: 'ieee-p1363',
      })
      .toString('base64url');

    const token = `${signingInput}.${signature}`;
    this.cachedJwt = { token, iat: now, keyId: cfg.keyId };
    return token;
  }

  /**
   * Sends a single push to one device token. Resolves (never rejects) with an
   * {@link ApnsSendResult}; `skipped` is true when APNs is not configured.
   */
  async sendDataNotification(deviceToken: string, req: ApnsRequest): Promise<ApnsSendResult> {
    const cfg = this.getConfig();
    const token = this.getProviderToken();
    if (!cfg || !token) {
      this.logger.debug('[APNS] not configured - skipping send (inert)');
      return { skipped: true };
    }

    const host = cfg.production
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    const body = Buffer.from(JSON.stringify(req.payload));

    return await new Promise<ApnsSendResult>((resolve) => {
      const session = http2.connect(host);
      let settled = false;
      const finish = (r: ApnsSendResult): void => {
        if (settled) return;
        settled = true;
        try {
          session.close();
        } catch {
          /* already closing */
        }
        resolve(r);
      };

      session.on('error', (e) => {
        this.logger.warn(`[APNS] session error: ${e}`);
        finish({ skipped: false, status: 0, reason: String(e) });
      });

      const stream = session.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${token}`,
        'apns-topic': cfg.bundleId,
        'apns-push-type': req.pushType,
        'apns-priority': String(req.priority),
        'content-type': 'application/json',
        'content-length': body.length,
      });

      let status = 0;
      let data = '';
      stream.on('response', (headers) => {
        status = Number(headers[':status']) || 0;
      });
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        data += chunk;
      });
      stream.on('end', () => {
        let reason = '';
        try {
          reason = data ? ((JSON.parse(data) as { reason?: string }).reason ?? '') : '';
        } catch {
          /* non-JSON body */
        }
        // 410 Unregistered or 400 BadDeviceToken/DeviceTokenNotForTopic => delete the token.
        const terminal =
          status === 410 ||
          reason === 'Unregistered' ||
          reason === 'BadDeviceToken' ||
          reason === 'DeviceTokenNotForTopic';
        finish({ skipped: false, status, reason, terminal });
      });
      stream.on('error', (e) => {
        this.logger.warn(`[APNS] request error: ${e}`);
        finish({ skipped: false, status: 0, reason: String(e) });
      });
      stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
        this.logger.warn('[APNS] request timeout');
        stream.close();
        finish({ skipped: false, status: 0, reason: 'timeout' });
      });

      stream.end(body);
    });
  }
}
