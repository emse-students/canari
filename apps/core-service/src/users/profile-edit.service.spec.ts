import { Logger } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { ProfileEditService } from './profile-edit.service';
import { MiconnectEditorClient } from './miconnect-editor.client';
import { validateProfileEdit } from './miconnect-profile';
import {
  PROFILE_EDIT_CODES,
  ProfileEditInvalidError,
  ProfileEditNotConfiguredError,
  ProfileEditNotLinkedError,
  ProfileEditUnavailableOnDevError,
  ProfileEditUpstreamError,
} from './profile-edit.errors';
import { ProfileChange } from './entities/profile-change.entity';
import { User } from './entities/user.entity';
import { UserRowGoneError } from './user-write';

const UUID = '11111111-2222-3333-4444-555555555555';
const EDIT = {
  campus: 'gardanne',
  cursus: [{ formation: 'ISMIN', promo: 2024 }],
  posts: ['ME'],
  firstName: 'Camille',
  lastName: 'Durand',
};

describe('validateProfileEdit', () => {
  it('accepts every formation the enrolment offers, PDIS included', () => {
    for (const formation of ['ICM', 'ISMIN', 'FISA', 'PDIS', 'Autre']) {
      const r = validateProfileEdit({ ...EDIT, cursus: [{ formation, promo: 2024 }] });
      expect(r.ok).toBe(true);
    }
  });

  it('accepts a complete profile and trims the names', () => {
    const r = validateProfileEdit({ ...EDIT, firstName: '  Camille ' });
    expect(r).toEqual({ ok: true, profile: { version: 1, ...EDIT } });
  });

  it('reports EVERY problem at once, naming the field', () => {
    const r = validateProfileEdit({
      campus: 'paris',
      cursus: [{ formation: 'MBA', promo: 2024 }],
      posts: ['CEO'],
      firstName: '',
      lastName: 'x',
    });
    expect(r.ok).toBe(false);
    const problems = (r as { problems: { field: string }[] }).problems;
    expect(problems.map((p) => p.field).sort()).toEqual(['campus', 'cursus', 'firstName', 'posts']);
  });

  it('enforces D11: a profile needs a cursus or a post', () => {
    const r = validateProfileEdit({ ...EDIT, cursus: [], posts: [] });
    expect(r).toEqual({
      ok: false,
      problems: [{ field: 'profile', reason: 'a profile needs a cursus or a post' }],
    });
  });

  it('refuses an impossible entry year and a non-object body', () => {
    expect(validateProfileEdit({ ...EDIT, cursus: [{ formation: 'ICM', promo: 1816 }] }).ok).toBe(
      false
    );
    expect(validateProfileEdit(null).ok).toBe(false);
    expect(validateProfileEdit([]).ok).toBe(false);
  });
});

describe('ProfileEditService', () => {
  const env = { ...process.env };
  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.DEPLOY_BUILD;
    process.env.AUTHENTIK_BASE_URL = 'https://miconnect.example/';
    process.env.MICONNECT_EDITOR_TOKEN = 'editor-token';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  function make(
    opts: { user?: Partial<User> | null; attributes?: Record<string, unknown>; gone?: boolean } = {}
  ) {
    const user = (
      opts.user === null
        ? null
        : { id: 'u-target', miconnectUuid: UUID, admin: false, ...opts.user }
    ) as User | null;
    const users = { findOne: jest.fn().mockResolvedValue(user) } as unknown as Repository<User>;
    const saved: unknown[] = [];
    // The user row is written as ONE column update; 0 rows once `gone`.
    const userRows = { update: jest.fn().mockResolvedValue({ affected: opts.gone ? 0 : 1 }) };
    const manager = {
      getRepository: jest.fn(() => userRows),
      save: jest.fn(async (_entity: unknown, value: unknown) => {
        saved.push(value);
        return { ...(value as object), id: 'change-1' };
      }),
      create: jest.fn((_entity: unknown, value: object) => ({ ...value })),
    };
    const dataSource = {
      transaction: jest.fn(async (fn: (m: typeof manager) => unknown) => fn(manager)),
    } as unknown as DataSource;
    const service = new ProfileEditService(users, dataSource, new MiconnectEditorClient());
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        return Response.json({
          results: [{ pk: 42, name: 'Old Name', attributes: opts.attributes ?? { keep: 'me' } }],
        });
      }
      expect(url).toBe(
        'https://miconnect.example/api/v3/flows/executor/miconnect-profile-write/?query='
      );
      return Response.json({ component: 'xak-flow-redirect', to: '/' });
    });
    return { service, user, manager, userRows, saved, fetchMock, dataSource };
  }

  it('writes authentik FIRST through the write flow, then the row, then the audit', async () => {
    const { service, user, manager, userRows, fetchMock } = make({
      attributes: { keep: 'me', promo: 2020, profile: { version: 1, campus: 'saint-etienne' } },
    });
    const result = await service.applyEdit('u-target', 'u-admin', EDIT);

    const [get, patch] = fetchMock.mock.calls;
    expect(String(get[0])).toBe(`https://miconnect.example/api/v3/core/users/?uuid=${UUID}`);
    expect(((get[1] as RequestInit).headers as Record<string, string>).Authorization).toBe(
      'Bearer editor-token'
    );
    expect(patch[1]?.method).toBe('POST');
    const sent = JSON.parse(patch[1]?.body as string);
    expect(sent.component).toBe('ak-stage-prompt');
    expect(sent.target).toBe(UUID);
    const changes = JSON.parse(sent.changes);
    expect(changes.name).toBe('Camille Durand');
    // The profile key ALONE: MiConnect merges it, so no other key is ever sent (or overwritten).
    expect(Object.keys(changes.attributes)).toEqual(['profile']);
    expect(changes.attributes.profile).toMatchObject({ version: 1, ...EDIT });

    expect(user).toMatchObject({
      campus: 'gardanne',
      posts: ['ME'],
      firstName: 'Camille',
      lastName: 'Durand',
      displayName: 'Camille Durand',
      promo: 2024,
      formation: 'ISMIN',
    });
    // The profile columns of the row, keyed by its id - never a save of the row read.
    expect(manager.getRepository).toHaveBeenCalledWith(User);
    expect(userRows.update).toHaveBeenCalledWith(
      { id: 'u-target' },
      expect.not.objectContaining({ admin: expect.anything() })
    );
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(manager.save.mock.calls[0][0]).toBe(ProfileChange);
    expect(manager.save.mock.calls[0][1]).toMatchObject({
      userId: 'u-target',
      actorId: 'u-admin',
      before: { version: 1, campus: 'saint-etienne' },
    });
    expect(result).toMatchObject({ changed: true, changeId: 'change-1' });
  });

  it('records a null before when authentik held no profile', async () => {
    const { service, manager } = make({ attributes: {} });
    await service.applyEdit('u-target', 'u-admin', EDIT);
    expect(manager.save.mock.calls[0][1]).toMatchObject({ before: null });
  });

  it('an identical profile writes nothing at authentik and leaves no audit row', async () => {
    // jsonb hands the keys back in its own order: the comparison must not care.
    const stored = {
      lastName: 'Durand',
      firstName: 'Camille',
      posts: ['ME'],
      cursus: [{ promo: 2024, formation: 'ISMIN' }],
      campus: 'gardanne',
      version: 1,
    };
    const { service, manager, userRows, fetchMock } = make({ attributes: { profile: stored } });
    const result = await service.applyEdit('u-target', 'u-admin', EDIT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(userRows.update).toHaveBeenCalledTimes(1);
    expect(manager.save).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: false, changeId: null });
  });

  it('DEV REFUSES with a typed error before touching the database or the network', async () => {
    process.env.DEPLOY_BUILD = 'dev.abc1234';
    const { service, fetchMock } = make();
    const attempt = service.applyEdit('u-target', 'u-admin', EDIT);
    await expect(attempt).rejects.toBeInstanceOf(ProfileEditUnavailableOnDevError);
    await expect(attempt).rejects.toMatchObject({
      response: { code: PROFILE_EDIT_CODES.devEstate },
      status: 403,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DEV REFUSES even when a token is somehow present', async () => {
    process.env.DEPLOY_BUILD = 'dev.abc1234';
    process.env.MICONNECT_EDITOR_TOKEN = 'leaked-into-dev';
    const { service, fetchMock } = make();
    await expect(service.applyEdit('u-target', 'u-admin', EDIT)).rejects.toBeInstanceOf(
      ProfileEditUnavailableOnDevError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('production without its token refuses with a typed error and an ACCUSING log', async () => {
    delete process.env.MICONNECT_EDITOR_TOKEN;
    const { service, fetchMock } = make();
    const attempt = service.applyEdit('u-target', 'u-admin', EDIT);
    await expect(attempt).rejects.toBeInstanceOf(ProfileEditNotConfiguredError);
    await expect(attempt).rejects.toMatchObject({
      response: { code: PROFILE_EDIT_CODES.notConfigured },
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('MICONNECT_EDITOR_TOKEN is unset')
    );
  });

  it('refuses an invalid edit with the problems, writing nothing', async () => {
    const { service, fetchMock, manager, userRows } = make();
    const attempt = service.applyEdit('u-target', 'u-admin', { ...EDIT, campus: 'mars' });
    await expect(attempt).rejects.toBeInstanceOf(ProfileEditInvalidError);
    await expect(attempt).rejects.toMatchObject({
      response: { code: PROFILE_EDIT_CODES.invalid, problems: [{ field: 'campus' }] },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(userRows.update).not.toHaveBeenCalled();
  });

  it('refuses a person who has no miconnect uuid yet', async () => {
    const { service, fetchMock } = make({ user: { miconnectUuid: null } });
    await expect(service.applyEdit('u-target', 'u-admin', EDIT)).rejects.toBeInstanceOf(
      ProfileEditNotLinkedError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an authentik failure stops everything: no row, no audit', async () => {
    const { service, manager, userRows, fetchMock } = make();
    fetchMock.mockImplementation(async (_url, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? Response.json({ results: [{ pk: 42, name: 'x', attributes: {} }] })
        : new Response('forbidden', { status: 403 })
    );
    const attempt = service.applyEdit('u-target', 'u-admin', EDIT);
    await expect(attempt).rejects.toBeInstanceOf(ProfileEditUpstreamError);
    await expect(attempt).rejects.toMatchObject({ upstreamStatus: 403, status: 502 });
    expect(manager.save).not.toHaveBeenCalled();
    expect(userRows.update).not.toHaveBeenCalled();
  });

  it('a row gone before its update is refused, typed, and no audit is written', async () => {
    const { service, manager } = make({ gone: true });
    await expect(service.applyEdit('u-target', 'u-admin', EDIT)).rejects.toBeInstanceOf(
      UserRowGoneError
    );
    expect(manager.save).not.toHaveBeenCalled();
  });

  function refusedWith(message: string) {
    const made = make();
    made.fetchMock.mockImplementation(async (_url, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? Response.json({ results: [{ pk: 42, name: 'x', attributes: {} }] })
        : Response.json({
            component: 'ak-stage-prompt',
            response_errors: { non_field_errors: [{ string: message }] },
          })
    );
    return made;
  }

  it('a refusal the account explains is typed by its code and logged below error', async () => {
    const { service, manager, userRows } = refusedWith(
      'refused:superuser: the target is a superuser'
    );
    const attempt = service.applyEdit('u-target', 'u-admin', EDIT);
    await expect(attempt).rejects.toBeInstanceOf(ProfileEditUpstreamError);
    await expect(attempt).rejects.toMatchObject({
      upstreamStatus: null,
      status: 502,
      refusal: 'superuser',
    });
    expect(warnLog).toHaveBeenCalledWith(expect.stringContaining('the target is a superuser'));
    expect(errorLog).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(userRows.update).not.toHaveBeenCalled();
  });

  it('a malformed write is a fault: typed, and logged at error', async () => {
    const { service } = refusedWith('refused:malformed: attribute(s) outside the allowlist');
    await expect(service.applyEdit('u-target', 'u-admin', EDIT)).rejects.toMatchObject({
      refusal: 'malformed',
    });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('outside the allowlist'));
  });

  it('a caller the write flow does not admit is an upstream error', async () => {
    const { service, fetchMock } = make();
    fetchMock.mockImplementation(async (_url, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? Response.json({ results: [{ pk: 42, name: 'x', attributes: {} }] })
        : Response.json({ component: 'ak-stage-access-denied' })
    );
    await expect(service.applyEdit('u-target', 'u-admin', EDIT)).rejects.toBeInstanceOf(
      ProfileEditUpstreamError
    );
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('ak-stage-access-denied'));
  });

  it('a uuid that matches no authentik user is an upstream error', async () => {
    const { service, fetchMock } = make();
    fetchMock.mockResolvedValue(Response.json({ results: [] }));
    await expect(service.applyEdit('u-target', 'u-admin', EDIT)).rejects.toBeInstanceOf(
      ProfileEditUpstreamError
    );
  });

  it('a failure AFTER authentik was written is logged as the sources disagreeing, and rethrown', async () => {
    const { service, dataSource } = make();
    (dataSource.transaction as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(service.applyEdit('u-target', 'u-admin', EDIT)).rejects.toThrow('db down');
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('sources disagree'));
  });
});
