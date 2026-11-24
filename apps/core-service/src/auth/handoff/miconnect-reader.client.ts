import { Injectable } from '@nestjs/common';
import { authentikRequest, type AuthentikAnswer } from '../../platform/authentik-api';
import { alumniProfileFacts, type AlumniFacts } from './alumni-access';

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
  /**
   * `attributes.cgu_version`: the terms-of-use text the person accepted (written by the consent
   * stage, infrastructure/authentik/blueprints/45-consent.yaml), `null` when they never accepted.
   */
  cguVersion: string | null;
  /**
   * What the Alumni rule reads (alumni-access.ts): the profile's cursus entry years and posts,
   * `attributes.alumni`, and the names of the groups the user is directly in. Whether an Alumni
   * connection exists is a separate read ({@link MiconnectReaderClient.alumniLinked}), made only
   * when it can change the answer.
   */
  facts: Omit<AlumniFacts, 'linked'>;
}

/**
 * THE TERMS-OF-USE VERSION, the fifth place of the version `check-consent-version.sh` pins: the
 * handoff mint passes a person through the consent flow's bindings only when they accepted THIS
 * text, which is what the flow itself would have asked of them.
 */
export const CONSENT_VERSION = '2026-11-24';

/** The consent flow's slug: the only flow on which bindings are recognised by an allowlist. */
export const CONSENT_FLOW_SLUG = 'miconnect-authorization';
/** The policy bound on the consent flow's two terms stage bindings (true = the page is shown). */
export const CONSENT_POLICY_NAME = 'miconnect-consent-needed';

/** Which question of the person an allowlisted binding asks - each is answered in handoff-access.ts. */
export type AllowlistedAnswer = 'consent' | 'linkReminder' | 'linkRequired';

/**
 * THE ALLOWLIST OF THE CONSENT FLOW: stage name -> the ONE policy recognised on its stage binding
 * (bound, not negated), and the answer that settles it. The terms prompt and write (the person's
 * `cgu_version`), and the Alumni link step of D44 (45-consent.yaml): its reminder, which a person
 * skips and which therefore never stops a mint, and its block, answered by alumni-access.ts. Any
 * other binding on the flow, or another policy on these stages, is counted in `flowBindings` and
 * refuses `policy_bound`.
 */
export const CONSENT_FLOW_ALLOWLIST: ReadonlyMap<
  string,
  { policy: string; answer: AllowlistedAnswer }
> = new Map([
  ['miconnect-consent-ask', { policy: CONSENT_POLICY_NAME, answer: 'consent' }],
  ['miconnect-consent-write', { policy: CONSENT_POLICY_NAME, answer: 'consent' }],
  [
    'miconnect-alumni-link-remind',
    { policy: 'miconnect-alumni-link-reminder', answer: 'linkReminder' },
  ],
  [
    'miconnect-alumni-link-require',
    { policy: 'miconnect-alumni-link-required', answer: 'linkRequired' },
  ],
]);

/**
 * THE ALUMNI GATE (D42-D43, 60-applications.yaml), recognised on these applications only, and only
 * in its exact shape: engine mode `any`, the policy {@link ALUMNI_GATE_POLICY} and the group
 * `acces-<application>`, both not negated, and nothing else bound. Answered by alumni-access.ts.
 */
export const ALUMNI_GATED_APPLICATIONS: ReadonlySet<string> = new Set(['migallery', 'cercle']);
export const ALUMNI_GATE_POLICY = 'miconnect-access-window-post-or-cotisant';

/** The slug of the Alumni SAML source, whose user connection the link step asks about. */
export const ALUMNI_SOURCE_SLUG = 'alumni';

/** A policy binding as the reader lists it. */
interface ListedBinding {
  negate?: boolean;
  policy_obj?: { name?: string } | null;
  group_obj?: { name?: string } | null;
  user_obj?: unknown;
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
  /**
   * Enabled bindings on the application itself, EXCEPT the Alumni gate when it is bound in its
   * exact allowlisted shape ({@link gateBindings}).
   */
  enabledBindings: number;
  /**
   * The Alumni gate's two bindings (policy {@link ALUMNI_GATE_POLICY} and group `acces-<app>`, mode
   * `any`) on an application of {@link ALUMNI_GATED_APPLICATIONS}; 0 otherwise.
   */
  gateBindings: number;
  /**
   * Enabled bindings on the flows an OIDC sign-in to the site walks through - the provider's
   * authentication and authorization flows - and on their stage bindings: a policy a handoff would
   * skip if it minted past it. Excludes the allowlisted ones below.
   */
  flowBindings: number;
  /**
   * Enabled bindings those flows carry that are EXACTLY the consent bindings (policy
   * {@link CONSENT_POLICY_NAME}, not negated, on a terms stage binding of {@link CONSENT_FLOW_SLUG}).
   * The person's own `cguVersion` answers them, so a mint through such a flow needs it to be current.
   */
  consentBindings: number;
  /** The D44 reminder's binding: a page the person skips, so it never stops a mint. */
  linkReminderBindings: number;
  /** The D44 block's binding: answered from the profile, the date and the Alumni connection. */
  linkRequiredBindings: number;
  /** The authorization flow's `authentication` requirement (`require_authenticated`, ...). */
  authorizationFlowAuthentication: string;
  /** The flag, `null` when the tenant never set it (authentik then applies its default, true). */
  defaultAccessFlag: boolean | null;
}

/**
 * READS MICONNECT through the read-only service account `miconnect-canari-handoff-reader`
 * (infrastructure/authentik/blueprints/55-handoff-reader.yaml): `view_user`, `view_application` on
 * the three handoff applications only, `view_policybinding`, `view_system_settings`, `view_flow`,
 * `view_flowstagebinding`, `view_usersourceconnection` - nothing that writes. Proven against a real authentik by `infrastructure/authentik/test-handoff-reader.py`.
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
    const body = await this.get<{
      results?: {
        pk: number;
        is_active: boolean;
        uid: string;
        attributes?: Record<string, unknown>;
        groups_obj?: { name?: unknown }[] | null;
      }[];
    }>(`/api/v3/core/users/?uuid=${encodeURIComponent(uuid)}`);
    const results = body.results ?? [];
    if (results.length === 0) return null;
    if (results.length > 1) {
      throw new MiconnectReadError('refused', `uuid matched ${results.length} users`);
    }
    if (typeof results[0].uid !== 'string' || !results[0].uid) {
      throw new MiconnectReadError('refused', 'the user answer carries no uid');
    }
    // The groups are part of the answer the gate reads: an answer without them is not one.
    const groups = results[0].groups_obj;
    if (!Array.isArray(groups)) {
      throw new MiconnectReadError('refused', 'the user answer carries no groups');
    }
    const attributes = results[0].attributes ?? {};
    const accepted = attributes.cgu_version;
    return {
      pk: results[0].pk,
      isActive: results[0].is_active === true,
      uid: results[0].uid,
      cguVersion: typeof accepted === 'string' ? accepted : null,
      facts: {
        ...alumniProfileFacts(attributes),
        groups: groups.map((g) => g.name).filter((n): n is string => typeof n === 'string'),
      },
    };
  }

  /**
   * Whether the user `pk` holds an Alumni user-source connection - what the D44 policies ask
   * (`UserSourceConnection` with source slug `alumni`, of any source type). Needs the GLOBAL
   * `view_usersourceconnection`: without it authentik answers with the caller's OWN connections
   * (none) rather than a 403, which would read as "not linked" - and a person refused
   * `alumni_link_required` wrongly is still only sent to MiConnect, which decides.
   */
  async alumniLinked(pk: number): Promise<boolean> {
    const answer = await this.get<{ pagination?: { count?: number } }>(
      `/api/v3/sources/user_connections/all/?user=${pk}&source__slug=${ALUMNI_SOURCE_SLUG}`
    );
    const count = answer.pagination?.count;
    if (typeof count !== 'number') {
      throw new MiconnectReadError('refused', 'the source connections answer carries no count');
    }
    return count > 0;
  }

  /** The inputs of `application`'s access decision (its slug at MiConnect). */
  async applicationAccess(application: string): Promise<MiconnectApplicationAccess> {
    const [app, settings] = await Promise.all([
      this.get<{
        pk: string;
        policy_engine_mode?: string;
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
      this.listBindings([app.pk]),
      this.flowGate(authorization),
      this.flowGate(authentication),
    ]);
    const gate = isAlumniGate(application, app.policy_engine_mode, appBindings)
      ? appBindings.length
      : 0;
    const flag = settings.flags?.core_default_app_access;
    return {
      enabledBindings: appBindings.length - gate,
      gateBindings: gate,
      flowBindings: authz.bindings + authn.bindings,
      consentBindings: authz.consent + authn.consent,
      linkReminderBindings: authz.linkReminder + authn.linkReminder,
      linkRequiredBindings: authz.linkRequired + authn.linkRequired,
      authorizationFlowAuthentication: authz.authentication,
      defaultAccessFlag: typeof flag === 'boolean' ? flag : null,
    };
  }

  /**
   * A flow's own enabled bindings plus those on each of its stage bindings, and its requirement.
   * `bindings` EXCLUDES the allowlisted ones ({@link CONSENT_FLOW_ALLOWLIST}), which are recognised
   * on the consent flow alone and counted per answer.
   */
  private async flowGate(
    flowUuid: string
  ): Promise<{ bindings: number; authentication: string } & Record<AllowlistedAnswer, number>> {
    const id = encodeURIComponent(flowUuid);
    const [flows, stages] = await Promise.all([
      this.get<{
        results?: { policybindingmodel_ptr_id?: string; authentication?: string; slug?: string }[];
      }>(`/api/v3/flows/instances/?flow_uuid=${id}`),
      this.get<{
        pagination?: { count?: number };
        results?: { policybindingmodel_ptr_id?: string; stage_obj?: { name?: string } }[];
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
    const counted: Record<AllowlistedAnswer, number> = {
      consent: 0,
      linkReminder: 0,
      linkRequired: 0,
    };
    if (flow[0].slug !== CONSENT_FLOW_SLUG) {
      return {
        bindings: await this.countBindings([own, ...stageTargets]),
        ...counted,
        authentication: requirement,
      };
    }
    // The consent flow: ONE listed page of every enabled binding on it gives the total, and the
    // allowlisted ones are found PER ALLOWLISTED STAGE BINDING, through the `target_in` filter. A
    // binding's own `target` field is NOT compared with a stage binding's id: on a real authentik it
    // never equalled `policybindingmodel_ptr_id` (CI, 2026-11-20), so that comparison matched nothing.
    const listed = await this.listBindings([own, ...stageTargets]);
    for (const stage of stages.results ?? []) {
      const allowed = CONSENT_FLOW_ALLOWLIST.get(stage.stage_obj?.name ?? '');
      if (!allowed) continue;
      const onStage = await this.listBindings([stage.policybindingmodel_ptr_id ?? '']);
      counted[allowed.answer] += onStage.filter(
        (b) => b.policy_obj?.name === allowed.policy && b.negate === false
      ).length;
    }
    const recognised = counted.consent + counted.linkReminder + counted.linkRequired;
    // More allowlisted bindings than bindings on the flow cannot be: the two reads disagree, and an
    // answer that disagrees with itself is not one the mint may open on.
    if (listed.length - recognised < 0) {
      throw new MiconnectReadError(
        'refused',
        `flow ${flowUuid.slice(0, 8)}: ${recognised} allowlisted bindings among ${listed.length}`
      );
    }
    return { bindings: listed.length - recognised, ...counted, authentication: requirement };
  }

  /** The enabled bindings on these targets, with what they bind - every one, or a refusal. */
  private async listBindings(targets: string[]): Promise<ListedBinding[]> {
    const query = targets.map((t) => `target_in=${encodeURIComponent(t)}`).join('&');
    const answer = await this.get<{
      pagination?: { count?: number };
      results?: ListedBinding[];
    }>(`/api/v3/policies/bindings/?${query}&enabled=true&page_size=${STAGE_PAGE}`);
    const results = answer.results ?? [];
    if (answer.pagination?.count !== results.length) {
      throw new MiconnectReadError('refused', 'the bindings were not all read');
    }
    return results;
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

/**
 * Whether `bindings` on `application` are EXACTLY the Alumni gate: an application of
 * {@link ALUMNI_GATED_APPLICATIONS}, engine mode `any`, and two bindings - the policy
 * {@link ALUMNI_GATE_POLICY} and the group `acces-<application>`, neither negated. Any other shape
 * (a third binding, mode `all`, a negation, a user binding) is not recognised and refuses.
 */
function isAlumniGate(
  application: string,
  mode: string | undefined,
  bindings: ListedBinding[]
): boolean {
  if (!ALUMNI_GATED_APPLICATIONS.has(application) || mode !== 'any' || bindings.length !== 2) {
    return false;
  }
  const plain = bindings.filter((b) => b.negate === false && !b.user_obj);
  const policy = plain.filter((b) => b.policy_obj?.name === ALUMNI_GATE_POLICY && !b.group_obj);
  const group = plain.filter((b) => b.group_obj?.name === `acces-${application}` && !b.policy_obj);
  return policy.length === 1 && group.length === 1;
}
