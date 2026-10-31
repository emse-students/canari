import axios from 'axios';
import { HttpException, Logger } from '@nestjs/common';
import { LydiaCashiersController } from './lydia-cashiers.controller';
import { InternalLydiaCashiersController } from './internal-lydia-cashiers.controller';
import {
  LYDIA_CASHIER_ADD_DISABLED,
  LYDIA_CASHIER_ADD_ENABLED,
  LYDIA_CASHIER_HOLDER_RIGHTS_MISSING,
  LYDIA_CASHIER_REVOKE_UNCONFIRMED,
  LYDIA_CASHIER_RIGHTS_INCOMPLETE,
  LYDIA_UNREACHABLE,
  LydiaCashierAddedUnconfirmedException,
} from './lydia-payment-provider';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import type { PaymentService } from './payment.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const ASSO = 'd1f769ce-6cb6-47b8-b20b-7636f59548da';
const ROW = '5b0b7d0e-4f8e-4d3a-9c55-0d6b7c0f1a11';
const PHONE = '+33612345678';
const CONTEXT_PHONE = '+33698765432';
const TOKEN = '2d0b7c6a-3f4e-4d5c-9b8a-7f6e5d4c3b2a';
const req = { headers: { 'x-user-id': 'treasurer' } } as never;

/** social-service's answers by route suffix; a value that is an Error is a refusal with that body. */
function social(answers: Record<string, unknown>) {
  mockedAxios.get.mockResolvedValue({ status: 200, data: { ok: true } });
  mockedAxios.post.mockImplementation(async (url: string) => {
    const suffix = Object.keys(answers)
      .sort((a, b) => b.length - a.length)
      .find((key) => url.endsWith(key));
    const answer = suffix ? answers[suffix] : { ok: true };
    if (answer && typeof answer === 'object' && 'status' in answer && 'refusal' in answer) {
      throw { response: { status: answer.status, data: answer.refusal } };
    }
    return { status: 200, data: answer };
  });
}

const postsTo = (suffix: string) =>
  mockedAxios.post.mock.calls.filter(([url]) => String(url).endsWith(suffix));

function make(service: Partial<Record<keyof PaymentService, jest.Mock>>, open = false) {
  const controller = new LydiaCashiersController(service as unknown as PaymentService);
  if (open) jest.spyOn(controller, 'cashierAddEnabled').mockReturnValue(true);
  return controller;
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  mockedAxios.post.mockReset();
  mockedAxios.get.mockReset();
});

describe('LydiaCashiersController - the owner gate (lot 3)', () => {
  it('ships OFF: adding a cashier is refused until a production removal has been observed', () => {
    expect(LYDIA_CASHIER_ADD_ENABLED).toBe(false);
  });

  it('gate off: an add is the typed 409 LYDIA_CASHIER_ADD_DISABLED, nothing claimed, nothing sent to Lydia', async () => {
    social({});
    const addLydiaCashier = jest.fn();
    await expect(
      make({ addLydiaCashier }).addCashier(
        ASSO,
        { userId: 'u2', phone: PHONE, role: 'vendeur' },
        req
      )
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_CASHIER_ADD_DISABLED } });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
    expect(addLydiaCashier).not.toHaveBeenCalled();
  });

  it('gate off: a role change is refused the same way', async () => {
    social({});
    await expect(make({}).changeRole(ASSO, ROW, { role: 'tresorier' }, req)).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_CASHIER_ADD_DISABLED },
    });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('every manager route runs NginxAuthGuard', () => {
    for (const handler of ['addCashier', 'changeRole', 'revokeCashier'] as const) {
      const fn = LydiaCashiersController.prototype[handler];
      expect(Reflect.getMetadata('__guards__', fn) as unknown[]).toContain(NginxAuthGuard);
    }
  });
});

describe('LydiaCashiersController - adding and changing a role (gate opened for the spec)', () => {
  it('claims, adds the role at Lydia, then records the row CONFIRMED with the actor as adder', async () => {
    social({
      '/lydia-cashier-add-claim': { vendorToken: 'vendor-1', claimToken: TOKEN },
      '/lydia-cashier': { cashier: { id: ROW } },
    });
    const addLydiaCashier = jest.fn().mockResolvedValue(undefined);
    await expect(
      make({ addLydiaCashier }, true).addCashier(
        ASSO,
        { userId: 'u2', phone: PHONE, role: 'vendeur' },
        req
      )
    ).resolves.toEqual({ ok: true, cashier: { id: ROW } });
    expect(addLydiaCashier).toHaveBeenCalledWith(ASSO, 'vendor-1', PHONE, 'vendeur');
    expect(postsTo('/lydia-cashier')[0][1]).toEqual({
      vendorToken: 'vendor-1',
      userId: 'u2',
      phone: PHONE,
      role: 'vendeur',
      addedByUserId: 'treasurer',
      confirmed: true,
      claimToken: TOKEN,
    });
  });

  it('a read-back that differs from the role records the row UNCONFIRMED, then answers the typed 502', async () => {
    social({
      '/lydia-cashier-add-claim': { vendorToken: 'vendor-1', claimToken: TOKEN },
      '/lydia-cashier': { cashier: { id: ROW } },
    });
    const mismatch = new LydiaCashierAddedUnconfirmedException(
      new HttpException({ code: LYDIA_CASHIER_RIGHTS_INCOMPLETE }, 502)
    );
    await expect(
      make({ addLydiaCashier: jest.fn().mockRejectedValue(mismatch) }, true).addCashier(
        ASSO,
        { userId: 'u2', phone: PHONE, role: 'tresorier' },
        req
      )
    ).rejects.toMatchObject({ status: 502, response: { code: LYDIA_CASHIER_RIGHTS_INCOMPLETE } });
    expect(postsTo('/lydia-cashier')[0][1]).toMatchObject({ confirmed: false });
  });

  it('a typed refusal before the add answered releases the claim; no answer keeps it', async () => {
    social({ '/lydia-cashier-add-claim': { vendorToken: 'vendor-1', claimToken: TOKEN } });
    await expect(
      make(
        { addLydiaCashier: jest.fn().mockRejectedValue(new HttpException({ code: 'X' }, 502)) },
        true
      ).addCashier(ASSO, { userId: 'u2', phone: PHONE, role: 'vendeur' }, req)
    ).rejects.toBeInstanceOf(HttpException);
    expect(postsTo('/lydia-cashier-release')).toHaveLength(1);
    // The release carries the claim's token: social-service clears only THAT claim.
    expect(postsTo('/lydia-cashier-release')[0][1]).toEqual({ claimToken: TOKEN });
    mockedAxios.post.mockClear();
    await expect(
      make(
        {
          addLydiaCashier: jest
            .fn()
            .mockRejectedValue(new HttpException({ code: LYDIA_UNREACHABLE }, 503)),
        },
        true
      ).addCashier(ASSO, { userId: 'u2', phone: PHONE, role: 'vendeur' }, req)
    ).rejects.toBeInstanceOf(HttpException);
    expect(postsTo('/lydia-cashier-release')).toHaveLength(0);
  });

  it('a role change re-adds the SAME number with the new role and records it on the row', async () => {
    social({
      '/lydia-cashier-role-claim': {
        vendorToken: 'vendor-1',
        phone: PHONE,
        userId: 'u2',
        claimToken: TOKEN,
      },
      '/lydia-cashier': { cashier: { id: ROW } },
    });
    const addLydiaCashier = jest.fn().mockResolvedValue(undefined);
    await make({ addLydiaCashier }, true).changeRole(ASSO, ROW, { role: 'tresorier' }, req);
    expect(addLydiaCashier).toHaveBeenCalledWith(ASSO, 'vendor-1', PHONE, 'tresorier');
    expect(postsTo('/lydia-cashier')[0][1]).toMatchObject({
      cashierId: ROW,
      role: 'tresorier',
      claimToken: TOKEN,
    });
  });
});

describe('LydiaCashiersController.revokeCashier - every removal verified (live, not gated)', () => {
  const claim = {
    vendorToken: 'vendor-1',
    cashierPhone: PHONE,
    contextPhone: CONTEXT_PHONE,
    claimToken: TOKEN,
  };

  it('a re-read at 0 of 13 closes the row (recorded verified) and answers ok', async () => {
    social({ '/lydia-cashier-revoke-claim': claim });
    const removeLydiaCashier = jest.fn().mockResolvedValue({ verified: true, held: 0 });
    await expect(
      make({ removeLydiaCashier }).revokeCashier(ASSO, ROW, { number: 'current' }, req)
    ).resolves.toEqual({ ok: true });
    expect(removeLydiaCashier).toHaveBeenCalledWith(ASSO, 'vendor-1', CONTEXT_PHONE, PHONE);
    expect(postsTo('/lydia-cashier-revoke')[0][1]).toEqual({
      cashierId: ROW,
      number: 'current',
      verified: true,
      actorId: 'treasurer',
      cashierPhone: PHONE,
      claimToken: TOKEN,
    });
  });

  it('a refusal before any change at Lydia releases the claim with its token', async () => {
    social({ '/lydia-cashier-revoke-claim': claim });
    await expect(
      make({
        removeLydiaCashier: jest
          .fn()
          .mockRejectedValue(new HttpException({ code: LYDIA_CASHIER_HOLDER_RIGHTS_MISSING }, 409)),
      }).revokeCashier(ASSO, ROW, { number: 'current' }, req)
    ).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_CASHIER_HOLDER_RIGHTS_MISSING },
    });
    expect(postsTo('/lydia-cashier-release')[0][1]).toEqual({ claimToken: TOKEN });
    expect(postsTo('/lydia-cashier-revoke')).toHaveLength(0);
  });

  it('a re-read that still shows rights: recorded NOT verified (row live, flagged) and the typed 502', async () => {
    social({ '/lydia-cashier-revoke-claim': claim });
    await expect(
      make({
        removeLydiaCashier: jest.fn().mockResolvedValue({ verified: false, held: 1 }),
      }).revokeCashier(ASSO, ROW, { number: 'current' }, req)
    ).rejects.toMatchObject({ status: 502, response: { code: LYDIA_CASHIER_REVOKE_UNCONFIRMED } });
    expect(postsTo('/lydia-cashier-revoke')[0][1]).toMatchObject({ verified: false });
  });

  it('the last holder: social-service refuses, and Lydia is never asked', async () => {
    social({
      '/lydia-cashier-revoke-claim': {
        status: 409,
        refusal: { code: 'LYDIA_CASHIER_LAST_HOLDER' },
      },
    });
    const removeLydiaCashier = jest.fn();
    await expect(
      make({ removeLydiaCashier }).revokeCashier(ASSO, ROW, { number: 'current' }, req)
    ).rejects.toMatchObject({ status: 409, response: { code: 'LYDIA_CASHIER_LAST_HOLDER' } });
    expect(removeLydiaCashier).not.toHaveBeenCalled();
  });
});

describe('InternalLydiaCashiersController - the erasure removal is internal only', () => {
  it('is declared under internal/, which nginx does not route', () => {
    expect(Reflect.getMetadata('path', InternalLydiaCashiersController)).toBe(
      'internal/lydia-cashiers'
    );
    // The public controller no longer carries any route of it.
    expect(
      (LydiaCashiersController.prototype as unknown as Record<string, unknown>).revokeForErasure
    ).toBeUndefined();
  });

  it('asks for the internal secret before anything', async () => {
    process.env.INTERNAL_SECRET = 'it-secret';
    const removeLydiaCashier = jest.fn();
    const controller = new InternalLydiaCashiersController({
      removeLydiaCashier,
    } as unknown as PaymentService);
    await expect(
      controller.revokeForErasure('wrong', {
        associationId: ASSO,
        vendorToken: 'vendor-1',
        contextPhone: CONTEXT_PHONE,
        cashierPhone: PHONE,
      })
    ).rejects.toBeInstanceOf(HttpException);
    expect(removeLydiaCashier).not.toHaveBeenCalled();
  });
});
