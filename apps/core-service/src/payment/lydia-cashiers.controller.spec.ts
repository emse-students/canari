import axios from 'axios';
import { HttpException, Logger } from '@nestjs/common';
import {
  LYDIA_CASHIER_NOT_A_MEMBER,
  LYDIA_RESPONSABLE_HANDOVER_HEIR_CASHIER_ON_CARD,
  LYDIA_RESPONSABLE_HANDOVER_HEIR_CASHIER_REMOVED,
  LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER,
  LydiaCashiersController,
} from './lydia-cashiers.controller';
import { InternalLydiaCashiersController } from './internal-lydia-cashiers.controller';
import {
  LYDIA_CASHIER_ADD_DISABLED,
  LYDIA_CASHIER_ADD_ENABLED,
  LYDIA_CASHIER_PHONE_RE,
  LYDIA_CASHIER_REMOVAL_PRECONDITION,
  LYDIA_CASHIER_REVOKE_UNCONFIRMED,
  LYDIA_CASHIER_RIGHTS_INCOMPLETE,
  LYDIA_RESPONSABLE_HANDOVER_DISABLED,
  LYDIA_RESPONSABLE_HANDOVER_ENABLED,
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

/**
 * The controller under test. `live` reads the shipped gate (ON since 1.7.1), so the add, role-change
 * specs exercise the path production runs; `off` closes it to pin the typed refusal a revert of the
 * switch would answer.
 */
function make(
  service: Partial<Record<keyof PaymentService, jest.Mock>>,
  gate: 'live' | 'off' = 'live'
) {
  const controller = new LydiaCashiersController(service as unknown as PaymentService);
  if (gate === 'off') jest.spyOn(controller, 'cashierAddEnabled').mockReturnValue(false);
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
  it('ships ON since 1.7.1 (owner, 2026-11-18): adding and changing a role reach Lydia', () => {
    expect(LYDIA_CASHIER_ADD_ENABLED).toBe(true);
    expect(make({}).cashierAddEnabled()).toBe(true);
  });

  it('gate off: an add is the typed 409 LYDIA_CASHIER_ADD_DISABLED, nothing claimed, nothing sent to Lydia', async () => {
    social({});
    const addLydiaCashier = jest.fn();
    await expect(
      make({ addLydiaCashier }, 'off').addCashier(
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
    await expect(
      make({}, 'off').changeRole(ASSO, ROW, { role: 'tresorier' }, req)
    ).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_CASHIER_ADD_DISABLED },
    });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('a French number keeping its trunk 0 is not a cashier phone: one line, one spelling', () => {
    expect(LYDIA_CASHIER_PHONE_RE.test('+33612345678')).toBe(true);
    expect(LYDIA_CASHIER_PHONE_RE.test('+330612345678')).toBe(false);
    expect(LYDIA_CASHIER_PHONE_RE.test('+3225123456')).toBe(true);
  });

  it('every manager route runs NginxAuthGuard', () => {
    for (const handler of [
      'addCashier',
      'changeRole',
      'revokeCashier',
      'handOverResponsable',
    ] as const) {
      const fn = LydiaCashiersController.prototype[handler];
      expect(Reflect.getMetadata('__guards__', fn) as unknown[]).toContain(NginxAuthGuard);
    }
  });
});

describe('LydiaCashiersController - adding and changing a role (the gate as shipped, ON)', () => {
  it('claims, adds the role at Lydia, then records the row CONFIRMED with the actor as adder', async () => {
    social({
      '/lydia-cashier-add-claim': { vendorToken: 'vendor-1', claimToken: TOKEN },
      '/lydia-cashier': { cashier: { id: ROW } },
    });
    const addLydiaCashier = jest.fn().mockResolvedValue(undefined);
    await expect(
      make({ addLydiaCashier }).addCashier(
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
      make({ addLydiaCashier: jest.fn().mockRejectedValue(mismatch) }).addCashier(
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
      make({
        addLydiaCashier: jest.fn().mockRejectedValue(new HttpException({ code: 'X' }, 502)),
      }).addCashier(ASSO, { userId: 'u2', phone: PHONE, role: 'vendeur' }, req)
    ).rejects.toBeInstanceOf(HttpException);
    expect(postsTo('/lydia-cashier-release')).toHaveLength(1);
    // The release carries the claim's token: social-service clears only THAT claim.
    expect(postsTo('/lydia-cashier-release')[0][1]).toEqual({ claimToken: TOKEN });
    mockedAxios.post.mockClear();
    await expect(
      make({
        addLydiaCashier: jest
          .fn()
          .mockRejectedValue(new HttpException({ code: LYDIA_UNREACHABLE }, 503)),
      }).addCashier(ASSO, { userId: 'u2', phone: PHONE, role: 'vendeur' }, req)
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
    await make({ addLydiaCashier }).changeRole(ASSO, ROW, { role: 'tresorier' }, req);
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
          .mockRejectedValue(new HttpException({ code: LYDIA_CASHIER_REMOVAL_PRECONDITION }, 409)),
      }).revokeCashier(ASSO, ROW, { number: 'current' }, req)
    ).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_CASHIER_REMOVAL_PRECONDITION },
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

  it("the Responsable's current number: social-service refuses, and Lydia is never asked", async () => {
    social({
      '/lydia-cashier-revoke-claim': {
        status: 409,
        refusal: { code: 'LYDIA_CASHIER_RESPONSABLE_NUMBER' },
      },
    });
    const removeLydiaCashier = jest.fn();
    await expect(
      make({ removeLydiaCashier }).revokeCashier(ASSO, ROW, { number: 'current' }, req)
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'LYDIA_CASHIER_RESPONSABLE_NUMBER' },
    });
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

  it('a departure takes the same verified removal; an unknown reason is refused before it', async () => {
    process.env.INTERNAL_SECRET = 'it-secret';
    const removeLydiaCashier = jest.fn().mockResolvedValue({ verified: true, held: 0 });
    const controller = new InternalLydiaCashiersController({
      removeLydiaCashier,
    } as unknown as PaymentService);
    const body = {
      associationId: ASSO,
      vendorToken: 'vendor-1',
      contextPhone: CONTEXT_PHONE,
      cashierPhone: PHONE,
    };
    await expect(
      controller.revokeForErasure('it-secret', { ...body, reason: 'departure' })
    ).resolves.toEqual({ verified: true, held: 0 });
    expect(removeLydiaCashier).toHaveBeenCalledWith(ASSO, 'vendor-1', CONTEXT_PHONE, PHONE);
    removeLydiaCashier.mockClear();
    await expect(
      controller.revokeForErasure('it-secret', { ...body, reason: 'other' })
    ).rejects.toBeInstanceOf(HttpException);
    expect(removeLydiaCashier).not.toHaveBeenCalled();
  });
});

describe('LydiaCashiersController - handing the Responsable over (owner, 2026-11-19)', () => {
  const HEIR = '+33611112222';
  const OLD_ROW = '7c1d8e2f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const NEW_ROW = '8d2e9f3a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
  const REVOKE_TOKEN = '3e1c8d7b-4a5f-4e6d-8c9b-0a1f2e3d4c5b';
  const selfReq = { headers: { 'x-user-id': 'holder' } } as never;
  const adminReq = { headers: { 'x-user-id': 'admin', 'x-global-admin': 'true' } } as never;

  /** The controller with the gate OPEN (it ships off): the path a flip would run. */
  function open(service: Partial<Record<keyof PaymentService, jest.Mock>>) {
    const controller = new LydiaCashiersController(service as unknown as PaymentService);
    jest.spyOn(controller, 'responsableHandoverEnabled').mockReturnValue(true);
    return controller;
  }
  const CLAIMED = {
    vendorToken: 'vendor-1',
    claimToken: TOKEN,
    previousResponsableId: OLD_ROW,
    retry: false,
  };
  /** social-service answering a hand-over that ends `outcome`, and the removal's claim. */
  function socialFor(outcome: 'handed-over' | 'unconfirmed' | 'target-left' | 'heir-ineligible') {
    const handed = outcome === 'handed-over';
    social({
      '/lydia-responsable-handover-claim': CLAIMED,
      '/lydia-responsable-handover': {
        outcome,
        cashierId: handed ? NEW_ROW : OLD_ROW,
        remove: outcome !== 'unconfirmed' ? 'previous' : null,
      },
      '/lydia-cashier-revoke-claim': {
        vendorToken: 'vendor-1',
        cashierPhone: handed ? CONTEXT_PHONE : HEIR,
        contextPhone: handed ? HEIR : CONTEXT_PHONE,
        claimToken: REVOKE_TOKEN,
      },
      '/lydia-cashier-revoke': { ok: true },
    });
  }
  /** The social-service routes core called, in order. */
  const steps = () => mockedAxios.post.mock.calls.map(([url]) => String(url).replace(/^.*\//, ''));
  const ask = { userId: 'heir', phone: HEIR };

  it('ships OFF: the typed 409, nothing claimed, Lydia never asked', async () => {
    social({});
    const addLydiaBusinessHolder = jest.fn();
    const controller = new LydiaCashiersController({
      addLydiaBusinessHolder,
    } as unknown as PaymentService);
    expect(LYDIA_RESPONSABLE_HANDOVER_ENABLED).toBe(false);
    await expect(controller.handOverResponsable(ASSO, ask, selfReq)).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_RESPONSABLE_HANDOVER_DISABLED },
    });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
    expect(addLydiaBusinessHolder).not.toHaveBeenCalled();
  });

  it('checks the payout permission before anything (its guard is pinned with the other routes)', async () => {
    mockedAxios.get.mockResolvedValue({ status: 403, data: { ok: false } });
    await expect(open({}).handOverResponsable(ASSO, ask, selfReq)).rejects.toMatchObject({
      status: 403,
    });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('ADD FIRST, REMOVE SECOND: claim, the 13 rights read back, record, then the old number removed and re-read', async () => {
    socialFor('handed-over');
    const order: string[] = [];
    const addLydiaBusinessHolder = jest.fn(async () => {
      order.push('add');
    });
    const removeLydiaCashier = jest.fn(async () => {
      order.push('remove');
      return { verified: true, held: 0 };
    });
    await expect(
      open({ addLydiaBusinessHolder, removeLydiaCashier }).handOverResponsable(ASSO, ask, selfReq)
    ).resolves.toEqual({ ok: true, outcome: 'handed-over', previousNumberRemoved: true });
    expect(order).toEqual(['add', 'remove']);
    expect(addLydiaBusinessHolder).toHaveBeenCalledWith(ASSO, 'vendor-1', HEIR);
    // The OLD number is removed with the HEIR's (now confirmed) number as the context.
    expect(removeLydiaCashier).toHaveBeenCalledWith(ASSO, 'vendor-1', HEIR, CONTEXT_PHONE);
    expect(steps()).toEqual([
      'lydia-responsable-handover-claim',
      'lydia-responsable-handover',
      'lydia-cashier-revoke-claim',
      'lydia-cashier-revoke',
    ]);
    expect(postsTo('/lydia-responsable-handover-claim')[0][1]).toEqual({
      actorId: 'holder',
      globalAdmin: false,
      userId: 'heir',
      phone: HEIR,
    });
    expect(postsTo('/lydia-responsable-handover')[0][1]).toEqual({
      vendorToken: 'vendor-1',
      userId: 'heir',
      phone: HEIR,
      previousResponsableId: OLD_ROW,
      actorId: 'holder',
      confirmed: true,
      claimToken: TOKEN,
    });
    expect(postsTo('/lydia-cashier-revoke-claim')[0][1]).toEqual({
      cashierId: NEW_ROW,
      number: 'previous',
    });
  });

  it('a platform admin ask carries globalAdmin for the identity check social-service makes', async () => {
    socialFor('handed-over');
    await open({
      addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
      removeLydiaCashier: jest.fn().mockResolvedValue({ verified: true, held: 0 }),
    }).handOverResponsable(ASSO, ask, adminReq);
    expect(postsTo('/lydia-responsable-handover-claim')[0][1]).toMatchObject({
      actorId: 'admin',
      globalAdmin: true,
    });
  });

  it('the 403 of social-service (not the Responsable) is passed on, typed, and Lydia is never asked', async () => {
    social({
      '/lydia-responsable-handover-claim': {
        status: 403,
        refusal: { code: 'LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN' },
      },
    });
    const addLydiaBusinessHolder = jest.fn();
    await expect(
      open({ addLydiaBusinessHolder }).handOverResponsable(ASSO, ask, req)
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN' },
    });
    expect(addLydiaBusinessHolder).not.toHaveBeenCalled();
  });

  it('a phone that is not E.164 is refused before any claim', async () => {
    social({});
    await expect(
      open({}).handOverResponsable(ASSO, { userId: 'heir', phone: '0611112222' }, selfReq)
    ).rejects.toMatchObject({ status: 400 });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('the add refused by Lydia (typed): the claim released, nothing recorded, the old Responsable untouched', async () => {
    socialFor('handed-over');
    await expect(
      open({
        addLydiaBusinessHolder: jest
          .fn()
          .mockRejectedValue(new HttpException({ code: 'LYDIA_SIGNATURE_REFUSED' }, 502)),
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({ status: 502, response: { code: 'LYDIA_SIGNATURE_REFUSED' } });
    expect(steps()).toEqual(['lydia-responsable-handover-claim', 'lydia-cashier-release']);
    expect(postsTo('/lydia-cashier-release')[0][1]).toEqual({ claimToken: TOKEN });
  });

  it('the add unanswered: the claim KEPT (the add may have happened), nothing recorded', async () => {
    socialFor('handed-over');
    await expect(
      open({
        addLydiaBusinessHolder: jest
          .fn()
          .mockRejectedValue(new HttpException({ code: LYDIA_UNREACHABLE }, 503)),
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({ status: 503 });
    expect(steps()).toEqual(['lydia-responsable-handover-claim']);
  });

  it('the re-read short of the 13: recorded UNCONFIRMED (the old Responsable stays), no removal, the typed 502', async () => {
    socialFor('unconfirmed');
    const removeLydiaCashier = jest.fn();
    const mismatch = new LydiaCashierAddedUnconfirmedException(
      new HttpException({ code: LYDIA_CASHIER_RIGHTS_INCOMPLETE }, 502)
    );
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockRejectedValue(mismatch),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({ status: 502, response: { code: LYDIA_CASHIER_RIGHTS_INCOMPLETE } });
    expect(postsTo('/lydia-responsable-handover')[0][1]).toMatchObject({ confirmed: false });
    expect(removeLydiaCashier).not.toHaveBeenCalled();
  });

  it('the old number not removed (the re-read still shows rights): handed over all the same, and said so', async () => {
    socialFor('handed-over');
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier: jest.fn().mockResolvedValue({ verified: false, held: 13 }),
      }).handOverResponsable(ASSO, ask, selfReq)
    ).resolves.toEqual({ ok: true, outcome: 'handed-over', previousNumberRemoved: false });
    // The removal's own record flagged it NOT confirmed: the card names it.
    expect(postsTo('/lydia-cashier-revoke')[0][1]).toMatchObject({ verified: false });
  });

  it('the removal refused before Lydia was asked: its claim released, handed over all the same', async () => {
    socialFor('handed-over');
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier: jest
          .fn()
          .mockRejectedValue(new HttpException({ code: LYDIA_CASHIER_REMOVAL_PRECONDITION }, 409)),
      }).handOverResponsable(ASSO, ask, selfReq)
    ).resolves.toMatchObject({ previousNumberRemoved: false });
    expect(postsTo('/lydia-cashier-release')[0][1]).toEqual({ claimToken: REVOKE_TOKEN });
  });

  it('another cashier operation took the claim before the removal: handed over, the old number waits on the card', async () => {
    social({
      '/lydia-responsable-handover-claim': CLAIMED,
      '/lydia-responsable-handover': {
        outcome: 'handed-over',
        cashierId: NEW_ROW,
        remove: 'previous',
      },
      '/lydia-cashier-revoke-claim': {
        status: 409,
        refusal: { code: 'LYDIA_CASHIER_IN_FLIGHT' },
      },
    });
    const removeLydiaCashier = jest.fn();
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, ask, selfReq)
    ).resolves.toMatchObject({ previousNumberRemoved: false });
    expect(removeLydiaCashier).not.toHaveBeenCalled();
  });

  it('the heir left while Lydia was asked: their number removed, the typed 409 NOT_A_MEMBER', async () => {
    socialFor('target-left');
    const removeLydiaCashier = jest.fn().mockResolvedValue({ verified: true, held: 0 });
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_CASHIER_NOT_A_MEMBER } });
    expect(removeLydiaCashier).toHaveBeenCalledWith(ASSO, 'vendor-1', CONTEXT_PHONE, HEIR);
  });

  it('the heir lost MANAGE_PAYOUT_ACCOUNT at the record: their number removed, the typed 409 HEIR_NOT_PAYOUT_MANAGER', async () => {
    socialFor('heir-ineligible');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const removeLydiaCashier = jest.fn().mockResolvedValue({ verified: true, held: 0 });
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER },
    });
    expect(removeLydiaCashier).toHaveBeenCalledWith(ASSO, 'vendor-1', CONTEXT_PHONE, HEIR);
    expect(String(warn.mock.calls)).toContain('no longer manages the payout account');
    warn.mockRestore();
  });

  it('the heir left AND Lydia did not confirm the rights: the refusal wins - removed, the typed 409, not the rights error', async () => {
    socialFor('target-left');
    const removeLydiaCashier = jest.fn().mockResolvedValue({ verified: true, held: 0 });
    await expect(
      open({
        addLydiaBusinessHolder: jest
          .fn()
          .mockRejectedValue(
            new LydiaCashierAddedUnconfirmedException(
              new HttpException({ code: LYDIA_CASHIER_RIGHTS_INCOMPLETE }, 502)
            )
          ),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_CASHIER_NOT_A_MEMBER } });
    expect(removeLydiaCashier).toHaveBeenCalledWith(ASSO, 'vendor-1', CONTEXT_PHONE, HEIR);
  });

  it('the record failing after the add (no answer): a 503, the claim kept for a global admin, no removal', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockedAxios.get.mockResolvedValue({ status: 200, data: { ok: true } });
    mockedAxios.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/lydia-responsable-handover-claim')) return { status: 200, data: CLAIMED };
      throw new Error('socket hang up');
    });
    const removeLydiaCashier = jest.fn();
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({ status: 503 });
    expect(steps()).toEqual(['lydia-responsable-handover-claim', 'lydia-responsable-handover']);
    expect(removeLydiaCashier).not.toHaveBeenCalled();
    // The claim is KEPT: the advice starts with a global admin clearing it, never a bare retry.
    const said = String(error.mock.calls);
    expect(said).toContain('the claim KEPT - a global admin clears it first');
    expect(said).not.toContain('refused the record');
    error.mockRestore();
  });

  it('the record REFUSED (typed) after Lydia added the 13 rights: said at ERROR - the heir, the last two digits, the way back', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    social({
      '/lydia-responsable-handover-claim': CLAIMED,
      '/lydia-responsable-handover': {
        status: 409,
        refusal: { code: 'LYDIA_CASHIER_CLAIM_LOST' },
      },
    });
    const removeLydiaCashier = jest.fn();
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, { userId: 'heir-user-0001', phone: HEIR }, selfReq)
    ).rejects.toMatchObject({ status: 409, response: { code: 'LYDIA_CASHIER_CLAIM_LOST' } });
    const said = String(error.mock.calls);
    expect(said).toContain('hand-over NOT recorded after Lydia added the number');
    expect(said).toContain('every right confirmed');
    expect(said).toContain('user heir-use');
    expect(said).toContain('phone ending 22');
    expect(said).toContain('refused the record (LYDIA_CASHIER_CLAIM_LOST), the claim released');
    expect(said).toContain('hand over again to the same member with the same number');
    expect(said).not.toContain('a global admin clears it first');
    expect(said).not.toContain(HEIR);
    expect(removeLydiaCashier).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('a promoted cashier who lost MANAGE_PAYOUT_ACCOUNT: their own number removed, the typed 409 says they are no longer a cashier', async () => {
    social({
      '/lydia-responsable-handover-claim': { ...CLAIMED, heirCashierId: NEW_ROW },
      '/lydia-responsable-handover': {
        outcome: 'heir-ineligible',
        cashierId: NEW_ROW,
        remove: 'current',
      },
      '/lydia-cashier-revoke-claim': {
        vendorToken: 'vendor-1',
        cashierPhone: HEIR,
        contextPhone: CONTEXT_PHONE,
        claimToken: REVOKE_TOKEN,
      },
      '/lydia-cashier-revoke': { ok: true },
    });
    const removeLydiaCashier = jest.fn().mockResolvedValue({ verified: true, held: 0 });
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_RESPONSABLE_HANDOVER_HEIR_CASHIER_REMOVED },
    });
    expect(postsTo('/lydia-cashier-revoke-claim')[0][1]).toEqual({
      cashierId: NEW_ROW,
      number: 'current',
    });
  });

  /** A promoted cashier refused at the record (heir-ineligible), the revoke claim answered `claim`. */
  function ineligibleCashier(claim: unknown) {
    social({
      '/lydia-responsable-handover-claim': { ...CLAIMED, heirCashierId: NEW_ROW },
      '/lydia-responsable-handover': {
        outcome: 'heir-ineligible',
        cashierId: NEW_ROW,
        remove: 'current',
      },
      '/lydia-cashier-revoke-claim': claim,
      '/lydia-cashier-revoke': { ok: true },
    });
  }

  it('a promoted cashier refused, their removal FAILED at Lydia: never "removed" - the typed 409 sends them to the card', async () => {
    ineligibleCashier({
      vendorToken: 'vendor-1',
      cashierPhone: HEIR,
      contextPhone: CONTEXT_PHONE,
      claimToken: REVOKE_TOKEN,
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const removeLydiaCashier = jest
      .fn()
      .mockRejectedValue(new HttpException({ code: 'LYDIA_CASHIER_REVOKE_UNCONFIRMED' }, 502));
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_RESPONSABLE_HANDOVER_HEIR_CASHIER_ON_CARD },
    });
    expect(removeLydiaCashier).toHaveBeenCalled();
    error.mockRestore();
  });

  it('a promoted cashier refused, their removal waiting on another operation (IN_FLIGHT): the typed 409 sends them to the card', async () => {
    ineligibleCashier({ status: 409, refusal: { code: 'LYDIA_CASHIER_IN_FLIGHT' } });
    const removeLydiaCashier = jest.fn();
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({
      status: 409,
      response: { code: LYDIA_RESPONSABLE_HANDOVER_HEIR_CASHIER_ON_CARD },
    });
    expect(removeLydiaCashier).not.toHaveBeenCalled();
  });

  it("a promoted cashier who left meanwhile: THEIR OWN row's current number removed", async () => {
    social({
      '/lydia-responsable-handover-claim': { ...CLAIMED, heirCashierId: NEW_ROW },
      '/lydia-responsable-handover': {
        outcome: 'target-left',
        cashierId: NEW_ROW,
        remove: 'current',
      },
      '/lydia-cashier-revoke-claim': {
        vendorToken: 'vendor-1',
        cashierPhone: HEIR,
        contextPhone: CONTEXT_PHONE,
        claimToken: REVOKE_TOKEN,
      },
      '/lydia-cashier-revoke': { ok: true },
    });
    const removeLydiaCashier = jest.fn().mockResolvedValue({ verified: true, held: 0 });
    await expect(
      open({
        addLydiaBusinessHolder: jest.fn().mockResolvedValue(undefined),
        removeLydiaCashier,
      }).handOverResponsable(ASSO, ask, selfReq)
    ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_CASHIER_NOT_A_MEMBER } });
    expect(postsTo('/lydia-cashier-revoke-claim')[0][1]).toEqual({
      cashierId: NEW_ROW,
      number: 'current',
    });
  });
});
