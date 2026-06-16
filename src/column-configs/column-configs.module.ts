import { Module } from '@nestjs/common';
import { ColumnConfigsController } from './column-configs.controller';
import { ColumnConfigsService } from './column-configs.service';
import { IColumnConfigRepository } from '../common/repositories/column-config.repository.interface';
import { InMemoryColumnConfigRepository } from '../common/repositories/column-config.repository';

@Module({
  controllers: [ColumnConfigsController],
  providers: [
    ColumnConfigsService,
    {
      provide: IColumnConfigRepository,
      useClass: InMemoryColumnConfigRepository,
    },
  ],
  exports: [ColumnConfigsService],
})
export class ColumnConfigsModule {}
