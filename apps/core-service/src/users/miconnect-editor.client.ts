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

/**
 * An authentik user as a LIST reads it: what the Alumni duplicates check needs (D47), and what an
 * admin is shown to tell two homonyms apart (the e-mail, the last sign-in).
 */
export interface MiconnectUserListing extends MiconnectUserRecord {
  uuid: string;
  username: string;
  type: string;
  email: string;
  is_active: boolean;
  /** ISO time of the last sign-in at MiConnect, null when it never signed in. */
  last_login: string | null;
}

/** One page of authentik's paginated list answer. */
interface AuthentikPage<T> {
  pagination?: { next?: number };
  results?: T[];
}

/** The most pages one listing walks: 100 users each, far above the estate (~1k accounts). */
const MAX_LIST_PAGES = 50;

/** The slug of MiConnect's write flow, the editor token's only write path (80-profile-editor.yaml). */
export const WRITE_FLOW = 'miconnect-profile-write';

/**
 * What one write may change: the display name, and the allowlisted attribute keys (`profile`, the
 * merge mark's three) - a key set to `null` is removed. MiConnect refuses anything else.
 */
export interface MiconnectUserWrite {
  name?: string;
  attributes?: Record<string, unknown>;
}

/** The part of a flow executor's answer the write reads: which challenge, and the prompt's errors. */
interface FlowChallenge {
  component?: string;
  response_errors?: Record<string, { string: string }[]>;
}

/**
 * Reads and writes a person at the source of truth: authentik, through the service account
 * `miconnect-canari-editor` (infrastructure/authentik/blueprints/80-profile-editor.yaml), whose role
 * may read users and their source connections, and write only through the flow `miconnect-profile-write`
 * ({@link writeUser}) - the profile, the name and the merge mark of a person, non-superuser account.
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
   * Writes `changes` on the account with this uuid, through the ONE write path the token has: the
   * flow `miconnect-profile-write` (80-profile-editor.yaml), one POST to authentik's flow executor
   * carrying the prompt. MiConnect MERGES the named attribute keys into the stored ones under the
   * account's row lock (`null` removes a key), so only what is named here is written and no
   * read-modify-write window exists.
   *
   * MiConnect refuses - nothing written - a field other than `name` and `attributes`, an attribute
   * other than `profile` and the merge mark's three keys, a mark on an account that is not `alumni-`,
   * a service account and a superuser. A refusal, an access-denied answer or anything but the flow's
   * end is a {@link ProfileEditUpstreamError}, logged at error with what MiConnect said.
   */
  async writeUser(uuid: string, changes: MiconnectUserWrite): Promise<void> {
    const { baseUrl, token } = this.assertAvailable();
    const url = `${baseUrl}/api/v3/flows/executor/${WRITE_FLOW}/?query=`;
    const answer = await this.call<FlowChallenge>('POST', url, token, {
      component: 'ak-stage-prompt',
      target: uuid,
      changes: JSON.stringify(changes),
    });
    if (answer.component === 'xak-flow-redirect') {
      this.logger.log(
        `[PROFILE_EDIT] MiConnect wrote ${uuid.slice(0, 8)}: ` +
          `${Object.keys(changes.attributes ?? {}).join(',') || '-'}${changes.name === undefined ? '' : ' +name'}`
      );
      return;
    }
    const said = Object.values(answer.response_errors ?? {})
      .flat()
      .map((e) => e.string)
      .join(' | ');
    this.logger.error(
      `[PROFILE_EDIT] MiConnect's write flow did not write ${uuid.slice(0, 8)}: ` +
        `${answer.component ?? 'no component'}${said ? ` (${said})` : ''}`
    );
    throw new ProfileEditUpstreamError(
      null,
      `write flow answered ${answer.component ?? 'nothing'}`
    );
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

  /**
   * The authentik user with this uuid, or null when there is none (deleted). Anything but zero or ONE
   * answer carrying exactly this uuid is an upstream fault, refused: the merge must never act on an
   * account it did not ask for because a filter was ignored.
   */
  async userByUuid(uuid: string): Promise<MiconnectUserListing | null> {
    const { baseUrl, token } = this.assertAvailable();
    const url = `${baseUrl}/api/v3/core/users/?uuid=${encodeURIComponent(uuid)}&include_groups=false`;
    const results =
      (await this.call<AuthentikPage<MiconnectUserListing>>('GET', url, token)).results ?? [];
    if (results.length === 0) return null;
    if (results.length !== 1 || results[0].uuid !== uuid) {
      this.logger.error(
        `[ALUMNI_MERGE] uuid ${uuid.slice(0, 8)} answered ${results.length} user(s), ` +
          `first ${results[0].uuid?.slice(0, 8)}`
      );
      throw new ProfileEditUpstreamError(null, `uuid answered ${results.length} users`);
    }
    return results[0];
  }

  /**
   * The slugs of every source the user `pk` is linked to (`cas-emse`, `alumni`...), read through
   * `view_usersourceconnection`. How the merge knows a duplicate holds the Alumni link and nothing
   * else, and that the target holds none, before marking it (D48).
   */
  async sourceSlugsOf(pk: number): Promise<string[]> {
    return (await this.sourceLinksOf(pk)).map((link) => link.slug);
  }

  /**
   * The source connections of user `pk`: each source's slug and the identifier the source signs in
   * with (for the Alumni source, the person's `af_id`). An unreadable slug or identifier is `'?'`/`null`.
   */
  async sourceLinksOf(pk: number): Promise<{ slug: string; identifier: string | null }[]> {
    const { baseUrl, token } = this.assertAvailable();
    const url = `${baseUrl}/api/v3/sources/user_connections/all/?user=${pk}&page_size=100`;
    const body = await this.call<
      AuthentikPage<{ source_obj?: { slug?: string }; identifier?: unknown }>
    >('GET', url, token);
    return (body.results ?? []).map((c) => ({
      slug: c.source_obj?.slug ?? '?',
      identifier: typeof c.identifier === 'string' ? c.identifier : null,
    }));
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
