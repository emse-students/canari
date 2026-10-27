import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseRecord } from './entities/purchase-record.entity';
import { PurchaseRecordClosing } from './entities/purchase-record-closing.entity';
import { PurchaseRecordService } from './purchase-record.service';

@Module({
  imports: [TypeOrmModule.forFeature([PurchaseRecord, PurchaseRecordClosing])],
  providers: [PurchaseRecordService],
  exports: [PurchaseRecordService],
})
export class PurchaseRecordModule {}
