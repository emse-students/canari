import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseRecord } from './entities/purchase-record.entity';
import { PurchaseRecordService } from './purchase-record.service';

@Module({
  imports: [TypeOrmModule.forFeature([PurchaseRecord])],
  providers: [PurchaseRecordService],
  exports: [PurchaseRecordService],
})
export class PurchaseRecordModule {}
