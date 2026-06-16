import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app.config';
import { JobsModule } from './jobs/jobs.module';
import { ColumnConfigsModule } from './column-configs/column-configs.module';

@Module({
  imports: [AppConfigModule, JobsModule, ColumnConfigsModule],
})
export class AppModule {}
