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

/** The MiConnect user a Canari account is, as the access decision needs it. */
export interface MiconnectAccount {
  pk: number;
  isActive: boolean;
}

/**
 * What MiConnect would decide an application's access FROM when no policy is bound: its enabled
 * bindings, and the tenant flag `core_default_app_access`.
 */
export interface MiconnectApplicationAccess {
  enabledBindings: number;
  /** The flag, `null` when the tenant never set it (authentik then applies its default, true). */
  defaultAccessFlag: boolean | null;
}

/**
 * READS MICONNECT through the read-only service account `miconnect-canari-handoff-reader`
 * (infrastructure/authentik/blueprints/55-handoff-reader.yaml): `view_user`, `view_application` on
 * the three handoff applications only, `view_policybinding`, `view_system_settings` - nothing that
 * writes. Proven against a real authentik by `infrastructure/authentik/test-handoff-reader.py`.
 *
 * Read-only, so dev MAY hold the token (dev and production share ONE MiConnect); the editor's
 * production-only rule is about writes.
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
    const body = await this.get<{ results?: { pk: number; is_active: boolean }[] }>(
      `/api/v3/core/users/?uuid=${encodeURIComponent(uuid)}`
    );
    const results = body.results ?? [];
    if (results.length === 0) return null;
    if (results.length > 1) {
      throw new MiconnectReadError('refused', `uuid matched ${results.length} users`);
    }
    return { pk: results[0].pk, isActive: results[0].is_active === true };
  }

  /** The inputs of `application`'s access decision (its slug at MiConnect). */
  async applicationAccess(application: string): Promise<MiconnectApplicationAccess> {
    const [app, settings] = await Promise.all([
      this.get<{ pk: string }>(`/api/v3/core/applications/${encodeURIComponent(application)}/`),
      this.get<{ flags?: Record<string, unknown> }>('/api/v3/admin/settings/'),
    ]);
    const bindings = await this.get<{ pagination?: { count?: number } }>(
      `/api/v3/policies/bindings/?target=${encodeURIComponent(app.pk)}&enabled=true`
    );
    const count = bindings.pagination?.count;
    if (typeof count !== 'number') {
      throw new MiconnectReadError('refused', 'the bindings answer carries no count');
    }
    const flag = settings.flags?.core_default_app_access;
    return {
      enabledBindings: count,
      defaultAccessFlag: typeof flag === 'boolean' ? flag : null,
    };
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
