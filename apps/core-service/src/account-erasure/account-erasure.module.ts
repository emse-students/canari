import { Module } from '@nestjs/common';
import { AccountErasureService } from './account-erasure.service';

/**
 * The durable account erasure: the request, the worker that drives it to completion, and the daily
 * report. Its table is registered on the root DataSource (`app.module.ts`); the service writes it
 * with raw SQL because the claim needs `FOR UPDATE SKIP LOCKED`.
 */
@Module({
  providers: [AccountErasureService],
  exports: [AccountErasureService],
})
export class AccountErasureModule {}
