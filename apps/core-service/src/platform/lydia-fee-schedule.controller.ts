import { Controller, Get, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { LydiaContractService, type LydiaFeeSchedule } from './lydia-contract.service';

/**
 * The fee schedule a price editor's payout estimate applies (`PayoutFeeHint.svelte`): the fee of a
 * payment Canari issues and the VAT, from the platform's Lydia contract terms - `{ schedule: null }`
 * while an admin has not entered them (docs/wiki/lydia-contract-flux.md). Signed-in callers only: the
 * estimate is drawn on the screens that edit a price, never on a public page.
 */
@Controller('payments')
export class LydiaFeeScheduleController {
  constructor(private readonly lydiaContract: LydiaContractService) {}

  /** Wrapped, so "not configured" is a readable body and never an empty one. */
  @UseGuards(NginxAuthGuard)
  @Get('lydia-fee-schedule')
  async getSchedule(): Promise<{ schedule: LydiaFeeSchedule }> {
    return { schedule: await this.lydiaContract.feeSchedule() };
  }
}
