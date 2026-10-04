import { Injectable, Logger } from '@nestjs/common';
import { isDevEstate } from '../platform/deploy-build';
import {
  ProfileEditNotConfiguredError,
  ProfileEditUnavailableOnDevError,
  ProfileEditUpstreamError,
} from './profile-edit.errors';

/** An authentik user as the editor reads it: the key to write to, and the whole attribute bag. */
export interface MiconnectUserRecord {
  pk: number;
  name: string;
  attributes: Record<string, unknown>;
}

const TIMEOUT_MS = 10_000;

/**
 * Reads and writes a person at the source of truth: authentik, through the service account
 * `miconnect-canari-editor` (infrastructure/authentik/blueprints/80-profile-editor.yaml), whose role
 * may view and change users and nothing else.
 *
 * PRODUCTION ONLY, and the refusal is a type. Dev and production share ONE MiConnect, so a dev
 * write would change a real person: {@link assertAvailable} throws
 * {@link ProfileEditUnavailableOnDevError} on dev, and {@link ProfileEditNotConfiguredError} on a
 * production that lost its token - logged at `error`, because that is a deployment fault.
 */
@Injectable()
export class MiconnectEditorClient {
  private readonly logger = new Logger(MiconnectEditorClient.name);

  /**
   * Throws unless this estate may write to MiConnect, and returns what the calls need. Read at call
   * time, never cached: the check is cheap and a test (or a restart) changes the environment.
   */
  assertAvailable(): { baseUrl: string; token: string } {
    if (isDevEstate()) {
      this.logger.warn(
        '[PROFILE_EDIT] refused: this is the dev estate, which shares production MiConnect'
      );
      throw new ProfileEditUnavailableOnDevError();
    }
    const baseUrl = (process.env.AUTHENTIK_BASE_URL ?? '').replace(/\/+$/, '');
    const token = process.env.MICONNECT_EDITOR_TOKEN?.trim() ?? '';
    const missing = !baseUrl ? 'AUTHENTIK_BASE_URL' : !token ? 'MICONNECT_EDITOR_TOKEN' : null;
    if (missing) {
      this.logger.error(
        `[PROFILE_EDIT] production cannot edit profiles: ${missing} is unset - a deployment fault, ` +
          'not a request to retry'
      );
      throw new ProfileEditNotConfiguredError(missing);
    }
    return { baseUrl, token };
  }

  /** The authentik user with this uuid, or an upstream error when there is not exactly one. */
  async findUserByUuid(uuid: string): Promise<MiconnectUserRecord> {
    const { baseUrl, token } = this.assertAvailable();
    const url = `${baseUrl}/api/v3/core/users/?uuid=${encodeURIComponent(uuid)}`;
    const body = await this.call<{ results?: MiconnectUserRecord[] }>('GET', url, token);
    const results = body.results ?? [];
    if (results.length !== 1) {
      this.logger.error(
        `[PROFILE_EDIT] uuid ${uuid.slice(0, 8)} matched ${results.length} authentik users`
      );
      throw new ProfileEditUpstreamError(null, `uuid matched ${results.length} users`);
    }
    return results[0];
  }

  /**
   * Writes the user's WHOLE `attributes` (and its display name). authentik's PATCH replaces the
   * `attributes` object rather than merging it, so the caller passes the bag it read with its change
   * applied - a partial bag would erase every other key.
   */
  async writeUser(
    pk: number,
    patch: { name?: string; attributes: Record<string, unknown> }
  ): Promise<void> {
    const { baseUrl, token } = this.assertAvailable();
    await this.call('PATCH', `${baseUrl}/api/v3/core/users/${pk}/`, token, patch);
  }

  private async call<T = unknown>(
    method: string,
    url: string,
    token: string,
    body?: unknown
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`[PROFILE_EDIT] authentik ${method} did not answer: ${String(err)}`);
      throw new ProfileEditUpstreamError(null, 'no answer');
    }
    if (!res.ok) {
      this.logger.error(
        `[PROFILE_EDIT] authentik ${method} ${new URL(url).pathname} answered ${res.status}`
      );
      throw new ProfileEditUpstreamError(res.status, `status ${res.status}`);
    }
    return (await res.json()) as T;
  }
}
