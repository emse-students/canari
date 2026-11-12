import { Injectable } from '@nestjs/common';
import { authentikRequest, type AuthentikAnswer } from '../../platform/authentik-api';

/**
 * Why a MiConnect read produced no usable answer - a TYPE, so the mint classifies at the throw:
 * `not_configured` (this estate holds no reader token or no MiConnect URL), `unreachable` (no
 * answer), `refused` (MiConnect answered with a status the read did not expect, e.g. a 403 when the
 * account lost a permission).
 */
export type MiconnectReadFailure = 'not_configured' | 'unreachable' | 'refused';

/** A MiConnect read that produced no usable answer, and where. Never carries the token. */
export class MiconnectReadError extends Error {
  constructor(
    readonly failure: MiconnectReadFailure,
    readonly detail: string
  ) {
    super(`MiConnect read ${failure}: ${detail}`);
    this.name = 'MiconnectReadError';
  }
}

/** One page holds every stage binding of a flow; more is refused, never guessed. */
const STAGE_PAGE = 100;

/** The MiConnect user a Canari account is, as the access decision needs it. */
export interface MiconnectAccount {
  pk: number;
  isActive: boolean;
  /**
   * authentik's `uid` - the OIDC `sub` of every provider in `hashed_user_id` mode (all of them,
   * read 2026-11-11), so it is the Canari account's own id when the uuid link is right.
   */
  uid: string;
}

/** The authorization-flow `authentication` modes that ask nothing beyond a signed-in user. */
export const OPEN_FLOW_AUTHENTICATION: ReadonlySet<string> = new Set([
  'none',
  'require_authenticated',
]);

/**
 * What MiConnect would decide an application's access FROM when no policy is bound: its enabled
 * bindings, and the tenant flag `core_default_app_access`.
 */
export interface MiconnectApplicationAccess {
  enabledBindings: number;
  /**
   * Enabled bindings on the flows an OIDC sign-in to the site walks through - the provider's
   * authentication and authorization flows - and on their stage bindings: a policy a handoff would
   * skip if it minted past it.
   */
  flowBindings: number;
  /** The authorization flow's `authentication` requirement (`require_authenticated`, ...). */
  authorizationFlowAuthentication: string;
  /** The flag, `null` when the tenant never set it (authentik then applies its default, true). */
  defaultAccessFlag: boolean | null;
}

/**
 * READS MICONNECT through the read-only service account `miconnect-canari-handoff-reader`
 * (infrastructure/authentik/blueprints/55-handoff-reader.yaml): `view_user`, `view_application` on
 * the three handoff applications only, `view_policybinding`, `view_system_settings`, `view_flow`,
 * `view_flowstagebinding` - nothing that writes. Proven against a real authentik by `infrastructure/authentik/test-handoff-reader.py`.
 *
 * Production only (lead, 2026-11-11): the token reads every MiConnect user, and dev mints nothing,
 * so dev holds none and its mint refuses `miconnect_not_configured`.
 */
@Injectable()
export class MiconnectReaderClient {
  /** The base URL and token, or null on an estate that holds neither. Read at call time. */
  config(): { baseUrl: string; token: string } | null {
    const baseUrl = (process.env.AUTHENTIK_BASE_URL ?? '').replace(/\/+$/, '');
    const token = process.env.MICONNECT_READER_TOKEN?.trim() ?? '';
    return baseUrl && token ? { baseUrl, token } : null;
  }

  /** The MiConnect user with this uuid; `null` when MiConnect knows no such user. */
  async findAccount(uuid: string): Promise<MiconnectAccount | null> {
    const body = await this.get<{ results?: { pk: number; is_active: boolean; uid: string }[] }>(
      `/api/v3/core/users/?uuid=${encodeURIComponent(uuid)}`
    );
    const results = body.results ?? [];
    if (results.length === 0) return null;
    if (results.length > 1) {
      throw new MiconnectReadError('refused', `uuid matched ${results.length} users`);
    }
    if (typeof results[0].uid !== 'string' || !results[0].uid) {
      throw new MiconnectReadError('refused', 'the user answer carries no uid');
    }
    return { pk: results[0].pk, isActive: results[0].is_active === true, uid: results[0].uid };
  }

  /** The inputs of `application`'s access decision (its slug at MiConnect). */
  async applicationAccess(application: string): Promise<MiconnectApplicationAccess> {
    const [app, settings] = await Promise.all([
      this.get<{
        pk: string;
        provider_obj?: { authentication_flow?: string | null; authorization_flow?: string | null };
      }>(`/api/v3/core/applications/${encodeURIComponent(application)}/`),
      this.get<{ flags?: Record<string, unknown> }>('/api/v3/admin/settings/'),
    ]);
    const authorization = app.provider_obj?.authorization_flow;
    const authentication = app.provider_obj?.authentication_flow;
    // A provider with no authentication flow of its own uses the BRAND's, which this account does
    // not read: refused rather than assumed open (every handoff provider names one, 2026-11-11).
    if (!authorization || !authentication) {
      throw new MiconnectReadError(
        'refused',
        `${application}: the provider names no ${authorization ? 'authentication' : 'authorization'} flow`
      );
    }
    const [appBindings, authz, authn] = await Promise.all([
      this.countBindings([app.pk]),
      this.flowGate(authorization),
      this.flowGate(authentication),
    ]);
    const flag = settings.flags?.core_default_app_access;
    return {
      enabledBindings: appBindings,
      flowBindings: authz.bindings + authn.bindings,
      authorizationFlowAuthentication: authz.authentication,
      defaultAccessFlag: typeof flag === 'boolean' ? flag : null,
    };
  }

  /** A flow's own enabled bindings plus those on each of its stage bindings, and its requirement. */
  private async flowGate(flowUuid: string): Promise<{ bindings: number; authentication: string }> {
    const id = encodeURIComponent(flowUuid);
    const [flows, stages] = await Promise.all([
      this.get<{
        results?: { policybindingmodel_ptr_id?: string; authentication?: string }[];
      }>(`/api/v3/flows/instances/?flow_uuid=${id}`),
      this.get<{
        pagination?: { count?: number };
        results?: { policybindingmodel_ptr_id?: string }[];
      }>(`/api/v3/flows/bindings/?target=${id}&page_size=${STAGE_PAGE}`),
    ]);
    const flow = flows.results ?? [];
    const own = flow[0]?.policybindingmodel_ptr_id;
    const requirement = flow[0]?.authentication;
    if (flow.length !== 1 || !own || !requirement) {
      throw new MiconnectReadError(
        'refused',
        `flow ${flowUuid.slice(0, 8)}: ${flow.length} answers`
      );
    }
    const stageTargets = (stages.results ?? []).map((s) => s.policybindingmodel_ptr_id ?? '');
    if (stages.pagination?.count !== stageTargets.length || stageTargets.some((t) => !t)) {
      throw new MiconnectReadError(
        'refused',
        `flow ${flowUuid.slice(0, 8)}: its stage bindings were not all read`
      );
    }
    const bindings = await this.countBindings([own, ...stageTargets]);
    return { bindings, authentication: requirement };
  }

  /** The enabled policy bindings on any of these binding targets (their `pbm_uuid`). */
  private async countBindings(targets: string[]): Promise<number> {
    const query = targets.map((t) => `target_in=${encodeURIComponent(t)}`).join('&');
    const answer = await this.get<{ pagination?: { count?: number } }>(
      `/api/v3/policies/bindings/?${query}&enabled=true`
    );
    const count = answer.pagination?.count;
    if (typeof count !== 'number') {
      throw new MiconnectReadError('refused', 'the bindings answer carries no count');
    }
    return count;
  }

  private async get<T>(path: string): Promise<T> {
    const config = this.config();
    if (!config) {
      throw new MiconnectReadError(
        'not_configured',
        'MICONNECT_READER_TOKEN or AUTHENTIK_BASE_URL is unset'
      );
    }
    const answer: AuthentikAnswer<T> = await authentikRequest<T>(
      'GET',
      `${config.baseUrl}${path}`,
      config.token
    );
    const where = path.split('?')[0];
    if (answer.kind === 'transport') {
      throw new MiconnectReadError('unreachable', `${where}: ${answer.error}`);
    }
    if (answer.kind === 'status') {
      throw new MiconnectReadError('refused', `${where} answered ${answer.status}`);
    }
    return answer.body;
  }
}
