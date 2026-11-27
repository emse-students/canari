import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Repository } from 'typeorm';
import { InternalMailController, mailDomainOf } from './internal-mail.controller';
import type { User } from '../users/entities/user.entity';
import {
  MiconnectReadError,
  type MiconnectAccount,
  type MiconnectReaderClient,
} from '../auth/handoff/miconnect-reader.client';

/**
 * THE MAIL RELAY'S ELIGIBILITY SOURCE (docs/wiki/mail-client-transport.md#eligibility): the domain
 * of the MiConnect address, read when asked, and only the domain leaves. Each answer the gateway
 * tells apart (apps/chat-gateway/src/mail_relay.rs, `Eligibility::domain_of`) is pinned here.
 */
describe('InternalMailController.mailDomain', () => {
  const SECRET = 'internal-secret-for-tests';
  const saved = process.env.INTERNAL_SECRET;
  beforeEach(() => {
    process.env.INTERNAL_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = saved;
  });

  function account(overrides: Partial<MiconnectAccount> = {}): MiconnectAccount {
    return {
      pk: 1,
      isActive: true,
      uid: 'user-1',
      cguVersion: null,
      email: 'Prenom.Nom@ETU.EMSE.FR',
      facts: {} as MiconnectAccount['facts'],
      ...overrides,
    };
  }

  function make(row: Partial<User> | null, found: MiconnectAccount | null | Error = account()) {
    const findOne = jest.fn(() => Promise.resolve(row as User | null));
    const findAccount = jest.fn(() =>
      found instanceof Error ? Promise.reject(found) : Promise.resolve(found)
    );
    const controller = new InternalMailController(
      { findOne } as unknown as Repository<User>,
      { findAccount } as unknown as MiconnectReaderClient
    );
    return { controller, findOne, findAccount };
  }

  it('answers the domain only, lowercased, of an active linked account', async () => {
    const { controller, findAccount } = make({ id: 'user-1', miconnectUuid: 'uuid-1' });
    await expect(controller.mailDomain('user-1', SECRET)).resolves.toEqual({
      domain: 'etu.emse.fr',
    });
    expect(findAccount).toHaveBeenCalledWith('uuid-1');
  });

  it('answers no domain for an inactive account or one with no address', async () => {
    const inactive = make({ id: 'user-1', miconnectUuid: 'u' }, account({ isActive: false }));
    await expect(inactive.controller.mailDomain('user-1', SECRET)).resolves.toEqual({
      domain: null,
    });
    const none = make({ id: 'user-1', miconnectUuid: 'u' }, account({ email: null }));
    await expect(none.controller.mailDomain('user-1', SECRET)).resolves.toEqual({ domain: null });
  });

  it('answers 404 for an account with no row, no link, or unknown to MiConnect', async () => {
    for (const { controller } of [
      make(null),
      make({ id: 'user-1', miconnectUuid: null }),
      make({ id: 'user-1', miconnectUuid: 'u' }, null),
    ]) {
      await expect(controller.mailDomain('user-1', SECRET)).rejects.toBeInstanceOf(
        NotFoundException
      );
    }
  });

  it('answers 503, never "no domain", when MiConnect could not be read', async () => {
    for (const failure of ['not_configured', 'unreachable', 'refused'] as const) {
      const { controller } = make(
        { id: 'user-1', miconnectUuid: 'u' },
        new MiconnectReadError(failure, 'test')
      );
      await expect(controller.mailDomain('user-1', SECRET)).rejects.toBeInstanceOf(
        ServiceUnavailableException
      );
    }
  });

  it("refuses to answer for a linked account that is another person's", async () => {
    const { controller } = make(
      { id: 'user-1', miconnectUuid: 'u' },
      account({ uid: 'someone-else' })
    );
    await expect(controller.mailDomain('user-1', SECRET)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a caller without the internal secret, and reads nothing', async () => {
    const { controller, findOne } = make({ id: 'user-1', miconnectUuid: 'u' });
    await expect(controller.mailDomain('user-1', 'wrong')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('mailDomainOf', () => {
  it('reads what follows the last @, lowercased', () => {
    expect(mailDomainOf('a@emse.fr')).toBe('emse.fr');
    expect(mailDomainOf('"odd@name"@Etu.Emse.Fr')).toBe('etu.emse.fr');
  });

  it('answers null for no address or no domain', () => {
    expect(mailDomainOf(null)).toBeNull();
    expect(mailDomainOf('')).toBeNull();
    expect(mailDomainOf('no-at-sign')).toBeNull();
    expect(mailDomainOf('trailing@')).toBeNull();
    expect(mailDomainOf('a@bad domain')).toBeNull();
  });
});
