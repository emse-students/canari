import { Controller, Get, Headers, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { LydiaContractService, type LydiaFeeSchedule } from './lydia-contract.service';

/**
 * The fee schedule a price editor's payout estimate applies (`PayoutFeeHint.svelte`): the fee of a
 * payment Canari issues and the VAT, from the platform's Lydia contract terms - `{ schedule: null }`
 * while an admin has not entered them (docs/wiki/lydia-contract-flux.md). A confidential contract
 * term, answered ONLY to a caller who may edit a price somewhere (owner, 2026-11-14:
 * social-service's `mayEditAPrice`); anyone else is a 403 `LYDIA_FEES_NOT_A_PRICE_EDITOR`.
 */
@Controller('payments')
export class LydiaFeeScheduleController {
  constructor(private readonly lydiaContract: LydiaContractService) {}

  /** Wrapped, so "not configured" is a readable body and never an empty one. */
  @UseGuards(NginxAuthGuard)
  @Get('lydia-fee-schedule')
  async getSchedule(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined
  ): Promise<{ schedule: LydiaFeeSchedule }> {
    await this.lydiaContract.assertMayReadFeeSchedule(
      xUserId.trim().toLowerCase(),
      xGlobalAdmin === 'true'
    );
    return { schedule: await this.lydiaContract.feeSchedule() };
  }
}
