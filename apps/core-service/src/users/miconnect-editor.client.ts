import { Injectable, Logger } from '@nestjs/common';
import { authentikRequest } from '../platform/authentik-api';
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

/** An authentik user as a LIST reads it: what the Alumni duplicates check needs (D47). */
export interface MiconnectUserListing extends MiconnectUserRecord {
  uuid: string;
  username: string;
  type: string;
}

/** One page of authentik's paginated list answer. */
interface AuthentikPage<T> {
  pagination?: { next?: number };
  results?: T[];
}

/** The most pages one listing walks: 100 users each, far above the estate (~1k accounts). */
const MAX_LIST_PAGES = 50;

/**
 * Reads and writes a person at the source of truth: authentik, through the service account
 * `miconnect-canari-editor` (infrastructure/authentik/blueprints/80-profile-editor.yaml), whose role
 * may view, change and delete users and read their source connections, and nothing else.
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

  /**
   * Every authentik user `search` finds (authentik matches it, case-insensitively, inside the
   * username, name, e-mail or uuid), all pages walked. The caller narrows: a search is a superset.
   * Refuses, rather than truncates, a listing longer than {@link MAX_LIST_PAGES} pages - an answer
   * that silently omitted the rest would look exactly like "no duplicate".
   */
  async searchUsers(search: string): Promise<MiconnectUserListing[]> {
    const { baseUrl, token } = this.assertAvailable();
    const out: MiconnectUserListing[] = [];
    let page = 1;
    for (let walked = 0; walked < MAX_LIST_PAGES; walked++) {
      const url =
        `${baseUrl}/api/v3/core/users/?search=${encodeURIComponent(search)}` +
        `&page=${page}&page_size=100&include_groups=false`;
      const body = await this.call<AuthentikPage<MiconnectUserListing>>('GET', url, token);
      out.push(...(body.results ?? []));
      const next = body.pagination?.next ?? 0;
      if (!next) return out;
      page = next;
    }
    this.logger.error(`[ALUMNI_MERGE] user search walked ${MAX_LIST_PAGES} pages without an end`);
    throw new ProfileEditUpstreamError(null, 'listing longer than the page bound');
  }

  /** The authentik users with this uuid: none (deleted) or one - a uuid is unique there. */
  async usersByUuid(uuid: string): Promise<MiconnectUserListing[]> {
    const { baseUrl, token } = this.assertAvailable();
    const url = `${baseUrl}/api/v3/core/users/?uuid=${encodeURIComponent(uuid)}&include_groups=false`;
    const body = await this.call<AuthentikPage<MiconnectUserListing>>('GET', url, token);
    return body.results ?? [];
  }

  /**
   * The slugs of every source the user `pk` is linked to (`cas-emse`, `alumni`...), read through
   * `view_usersourceconnection`. How the merge knows a duplicate holds the Alumni link and nothing
   * else before deleting it (D48).
   */
  async sourceSlugsOf(pk: number): Promise<string[]> {
    const { baseUrl, token } = this.assertAvailable();
    const url = `${baseUrl}/api/v3/sources/user_connections/all/?user=${pk}&page_size=100`;
    const body = await this.call<AuthentikPage<{ source_obj?: { slug?: string } }>>(
      'GET',
      url,
      token
    );
    return (body.results ?? []).map((c) => c.source_obj?.slug ?? '?');
  }

  /**
   * DELETES the authentik user `pk`; its source connections go with it (authentik cascades). Only
   * the Alumni merge calls this, and only after `AlumniMergeService` proved the account a duplicate.
   */
  async deleteUser(pk: number): Promise<void> {
    const { baseUrl, token } = this.assertAvailable();
    await this.call('DELETE', `${baseUrl}/api/v3/core/users/${pk}/`, token);
  }

  private async call<T = unknown>(
    method: string,
    url: string,
    token: string,
    body?: unknown
  ): Promise<T> {
    const answer = await authentikRequest<T>(method, url, token, body);
    if (answer.kind === 'transport') {
      this.logger.error(`[PROFILE_EDIT] authentik ${method} did not answer: ${answer.error}`);
      throw new ProfileEditUpstreamError(null, 'no answer');
    }
    if (answer.kind === 'status') {
      this.logger.error(
        `[PROFILE_EDIT] authentik ${method} ${new URL(url).pathname} answered ${answer.status}`
      );
      throw new ProfileEditUpstreamError(answer.status, `status ${answer.status}`);
    }
    return answer.body;
  }
}
